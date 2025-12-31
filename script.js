console.log("DTR-pathology Game loaded");

const modelURL = "./model/model.json";
const metadataURL = "./model/metadata.json";

// Game state
let model;
let video;
let canvas;
let ctx;
let isRunning = false;
let videoTrack;
let score = 0;
let correctCount = 0;
let mistakeCount = 0;

// Detection state
const TOOLS = ["1-2", "7-8", "9-10", "11-12", "13-14", "17-18"];
let detectionBuffer = [];
const BUFFER_SIZE = 16; // ~2.4 seconds of stable detection
const CONFIDENCE_THRESHOLD = 0.70;
let awaitingAnswer = false;
let currentCase = 0;

// Pathology cases
const PATHOLOGY_CASES = [
    { image: "A.png", correctTool: "7-8", description: "Tartar buildup on lower molars" },
    { image: "B.png", correctTool: "11-12", description: "Deep cavity requiring excavation" },
    { image: "C.png", correctTool: "1-2", description: "General oral inspection needed" },
    { image: "D.png", correctTool: "9-10", description: "Suspected occlusal decay" },
    { image: "E.png", correctTool: "13-14", description: "Supragingival calculus" },
    { image: "F.png", correctTool: "17-18", description: "Enamel preparation required" }
];

// Harmful tool combinations
const HARMFUL_COMBINATIONS = [
    { pathology: "A.png", harmfulTool: "17-18", reason: "Using drill on tartar can damage healthy enamel" },
    { pathology: "B.png", harmfulTool: "7-8", reason: "Scaler cannot treat deep cavities - excavation needed" },
    { pathology: "C.png", harmfulTool: "11-12", reason: "Never drill during general inspection without diagnosis" },
    { pathology: "D.png", harmfulTool: "13-14", reason: "Incorrect tool - explorer needed for decay detection" },
    { pathology: "E.png", harmfulTool: "17-18", reason: "Drill is excessive for calculus removal" },
    { pathology: "F.png", harmfulTool: "7-8", reason: "Scaler insufficient for enamel preparation" }
];

// Simple sound functions
function playCorrectSound() {
    try {
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const oscillator = audioContext.createOscillator();
        const gainNode = audioContext.createGain();
        
        oscillator.connect(gainNode);
        gainNode.connect(audioContext.destination);
        
        oscillator.frequency.value = 800;
        oscillator.type = 'sine';
        
        gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.2);
        
        oscillator.start(audioContext.currentTime);
        oscillator.stop(audioContext.currentTime + 0.2);
    } catch (e) {
        console.log("Audio not available");
    }
}

function playWrongSound() {
    try {
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const oscillator = audioContext.createOscillator();
        const gainNode = audioContext.createGain();
        
        oscillator.connect(gainNode);
        gainNode.connect(audioContext.destination);
        
        oscillator.frequency.value = 200;
        oscillator.type = 'sawtooth';
        
        gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.3);
        
        oscillator.start(audioContext.currentTime);
        oscillator.stop(audioContext.currentTime + 0.3);
    } catch (e) {
        console.log("Audio not available");
    }
}

// Show status message
function showStatus(message, isError = false) {
    const statusEl = document.getElementById("statusMessage");
    if (statusEl) {
        statusEl.innerText = message;
        statusEl.style.color = isError ? "#b00020" : "#333";
    }
    console.log(message);
}

// Load model
async function loadModel() {
    console.log("Loading model...");
    
    if (typeof tmImage === 'undefined') {
        throw new Error("Teachable Machine library not loaded");
    }
    
    showStatus("Loading AI model...");
    
    try {
        model = await tmImage.load(modelURL, metadataURL);
        console.log("Model loaded:", model.getClassLabels().join(", "));
        showStatus("Model ready!");
        return true;
    } catch (err) {
        console.error("Model error:", err);
        showStatus("Failed to load model: " + err.message, true);
        throw err;
    }
}

// Start camera
async function startCamera() {
    console.log("Starting camera...");
    video = document.getElementById("video");
    canvas = document.getElementById("canvas");
    ctx = canvas.getContext("2d");

    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: {
                facingMode: { ideal: "environment" },
                width: { ideal: 224 },
                height: { ideal: 224 }
            },
            audio: false
        });
        
        video.srcObject = stream;
        videoTrack = stream.getVideoTracks()[0];

        // Try torch
        try {
            const capabilities = videoTrack.getCapabilities();
            if (capabilities.torch) {
                await videoTrack.applyConstraints({ advanced: [{ torch: true }] });
                console.log("Torch enabled");
            }
        } catch (e) {
            console.log("Torch not available");
        }

        return new Promise((resolve) => {
            video.onloadedmetadata = () => {
                video.play().then(() => {
                    console.log("Camera started successfully");
                    resolve();
                });
            };
        });

    } catch (err) {
        console.error("Camera error:", err);
        showStatus("Camera error: " + err.message, true);
        throw err;
    }
}

// Update stability bar
function updateStabilityBar(progress) {
    const bar = document.getElementById("stabilityProgress");
    if (bar) {
        bar.style.width = (progress * 100) + "%";
    }
}

// Show current pathology case
function showPathologyCase() {
    const caseData = PATHOLOGY_CASES[currentCase];
    
    document.getElementById("pathologyImage").src = `./pathology/${caseData.image}`;
    
    const instructionEl = document.getElementById("pathologyInstruction");
    if (instructionEl) {
        instructionEl.innerText = "Present the correct tool to treat this condition";
    }
    
    awaitingAnswer = true;
    detectionBuffer = [];
    
    document.getElementById("correctToolDisplay").style.display = "none";
    document.getElementById("feedback").innerHTML = "";
}

// Prediction loop with buffering
async function predictLoop() {
    if (!isRunning) return;

    try {
        ctx.drawImage(video, 0, 0, 224, 224);
        const prediction = await model.predict(canvas);

        let best = prediction[0];
        for (let p of prediction) {
            if (p.probability > best.probability) {
                best = p;
            }
        }

        const detectedClass = best.className;
        const confidence = best.probability;

        // Update detection display
        const detectedToolEl = document.getElementById("detectedTool");
        if (detectedToolEl) {
            detectedToolEl.innerText = 
                TOOLS.includes(detectedClass) ? `Tool ${detectedClass}` : "Show a tool...";
        }

        // Process detection if awaiting answer
        if (awaitingAnswer && TOOLS.includes(detectedClass) && confidence >= CONFIDENCE_THRESHOLD) {
            
            // Add to buffer
            detectionBuffer.push(detectedClass);
            if (detectionBuffer.length > BUFFER_SIZE) {
                detectionBuffer.shift();
            }

            // Check if buffer is stable
            const mostCommon = detectionBuffer.reduce((acc, val) => {
                acc[val] = (acc[val] || 0) + 1;
                return acc;
            }, {});

            const stableDetection = Object.keys(mostCommon).find(
                tool => mostCommon[tool] >= BUFFER_SIZE * 0.8
            );

            if (stableDetection) {
                updateStabilityBar(1);
                // Stable detection - check answer
                checkAnswer(stableDetection);
            } else {
                updateStabilityBar(detectionBuffer.length / BUFFER_SIZE);
            }
        } else if (!awaitingAnswer) {
            updateStabilityBar(0);
            detectionBuffer = [];
        } else {
            // Detection lost
            if (detectionBuffer.length > 0) {
                detectionBuffer = [];
                updateStabilityBar(0);
            }
        }

    } catch (err) {
        console.error("Prediction error:", err);
    }

    setTimeout(() => requestAnimationFrame(predictLoop), 150);
}

// Check if tool is harmful for current pathology
function isHarmfulCombination(pathologyImage, tool) {
    return HARMFUL_COMBINATIONS.find(
        combo => combo.pathology === pathologyImage && combo.harmfulTool === tool
    );
}

// Check answer
function checkAnswer(detectedTool) {
    awaitingAnswer = false;
    detectionBuffer = [];
    updateStabilityBar(0);

    const caseData = PATHOLOGY_CASES[currentCase];
    const feedback = document.getElementById("feedback");
    const isCorrect = detectedTool === caseData.correctTool;
    
    // Check if harmful
    const harmfulCombo = isHarmfulCombination(caseData.image, detectedTool);

    if (isCorrect) {
        // Correct answer
        score += 10;
        correctCount++;
        
        feedback.innerHTML = `
            <div class="feedbackCorrect">
                ✓ Correct! Tool ${detectedTool} is appropriate<br>
                +10 points
            </div>
        `;
        
        playCorrectSound();

    } else {
        // Wrong answer
        mistakeCount++;
        
        if (harmfulCombo) {
            // Harmful combination - extra penalty
            score = Math.max(0, score - 8);
            
            feedback.innerHTML = `
                <div class="feedbackHarmful">
                    ⚠️ HARMFUL CHOICE! -8 points<br>
                    <strong>${harmfulCombo.reason}</strong><br>
                    Correct tool: ${caseData.correctTool}
                </div>
            `;
        } else {
            // Just wrong, not harmful
            score = Math.max(0, score - 3);
            
            feedback.innerHTML = `
                <div class="feedbackWrong">
                    ✗ Incorrect. -3 points<br>
                    You selected: Tool ${detectedTool}<br>
                    Correct tool: ${caseData.correctTool}
                </div>
            `;
        }
        
        playWrongSound();
    }

    // Update score display
    document.getElementById("score").innerText = score;
    document.getElementById("correct").innerText = correctCount;
    document.getElementById("mistakes").innerText = mistakeCount;

    // Show correct tool diagram
    const correctDiagram = document.getElementById("correctDiagram");
    correctDiagram.src = `./mouth-diagrams/${caseData.correctTool}.png`;
    document.getElementById("correctToolDisplay").style.display = "block";
}

// Next case
function nextCase() {
    currentCase++;
    
    if (currentCase >= PATHOLOGY_CASES.length) {
        // Game over
        showGameOver();
    } else {
        showPathologyCase();
    }
}

// Show game over screen
function showGameOver() {
    const feedback = document.getElementById("feedback");
    const percentage = Math.round((correctCount / PATHOLOGY_CASES.length) * 100);
    
    feedback.innerHTML = `
        <div class="gameOver">
            <h2>Quiz Complete!</h2>
            <p><strong>Final Score:</strong> ${score} points</p>
            <p><strong>Accuracy:</strong> ${correctCount}/${PATHOLOGY_CASES.length} (${percentage}%)</p>
            <p><strong>Mistakes:</strong> ${mistakeCount}</p>
            <button onclick="location.reload()">Play Again</button>
        </div>
    `;
    
    document.getElementById("correctToolDisplay").style.display = "none";
    document.getElementById("pathologyContainer").style.display = "none";
    awaitingAnswer = false;
}

// Start game
async function startGame() {
    console.log("Starting game...");
    
    document.getElementById("startScreen").style.display = "none";
    document.getElementById("gameScreen").style.display = "block";
    
    showStatus("Starting game...");
    
    try {
        await loadModel();
        await startCamera();
        
        isRunning = true;
        showStatus("Game started!");
        
        // Show first case
        showPathologyCase();
        predictLoop();
        
    } catch (err) {
        console.error("Game start error:", err);
        showStatus("Error: " + err.message, true);
        alert("Failed to start: " + err.message);
    }
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', function() {
    console.log("DOM ready - DTR-pathology");
    
    // Start button
    const startBtn = document.getElementById("startBtn");
    if (startBtn) {
        console.log("Start button found");
        startBtn.addEventListener("click", function() {
            console.log("Start button clicked");
            startGame();
        });
    } else {
        console.error("Start button NOT found!");
    }
    
    // Next button
    const nextBtn = document.getElementById("nextBtn");
    if (nextBtn) {
        nextBtn.addEventListener("click", nextCase);
    }
});
