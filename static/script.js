'use strict';

const socket = io({
    transports: ['polling', 'websocket'],
    reconnectionAttempts: 5,
    reconnectionDelay: 1000
});

let currentUsername = '';

document.getElementById('btn-join').onclick = () => {
    currentUsername = document.getElementById('input-username').value;
    let roomId = document.getElementById('input-room-id').value.trim();
    if (!roomId) {
        roomId = 'room_' + Math.random().toString(36).substring(2, 9);
    }
    document.getElementById('join-modal').style.display = 'none';
    document.getElementById('app-container').style.display = 'flex';
    document.getElementById('room-id-display').innerText = 'ルームID: ' + roomId;
    
    socket.emit('join', { room: roomId, username: currentUsername });
    initWhiteboard();
    initWebRTC();
    initChat();
    initLayoutAndDrag();
};

function initWhiteboard() {
    const bgCanvas = document.getElementById('layer-bg');
    const layersStack = document.getElementById('layers-stack');
    const canvasContainer = document.getElementById('canvas-container');
    const workspace = document.getElementById('workspace');
    
    // 無限キャンパスとして十分に広く、かつ軽量なサイズ
    const boardWidth = 16000;
    const boardHeight = 16000;
    
    bgCanvas.width = boardWidth;
    bgCanvas.height = boardHeight;
    const bgCtx = bgCanvas.getContext('2d', { alpha: false });
    bgCtx.fillStyle = '#ffffff';
    bgCtx.fillRect(0, 0, boardWidth, boardHeight);

    const localDraftCanvas = document.createElement('canvas');
    localDraftCanvas.className = 'layer-canvas';
    localDraftCanvas.width = boardWidth;
    localDraftCanvas.height = boardHeight;
    localDraftCanvas.style.zIndex = '100';
    localDraftCanvas.style.pointerEvents = 'none';
    layersStack.appendChild(localDraftCanvas);
    const localDraftCtx = localDraftCanvas.getContext('2d');

    const remoteDrafts = {};
    function getRemoteDraft(user) {
        if (!remoteDrafts[user]) {
            const canvas = document.createElement('canvas');
            canvas.className = 'layer-canvas';
            canvas.width = boardWidth;
            canvas.height = boardHeight;
            canvas.style.zIndex = '99';
            canvas.style.pointerEvents = 'none';
            layersStack.appendChild(canvas);
            remoteDrafts[user] = { canvas, ctx: canvas.getContext('2d') };
        }
        return remoteDrafts[user];
    }

    let layers = [];
    let activeLayerId = null;
    let undoStack = [];
    let redoStack = [];

    // 初期表示でキャンパス中央が画面中央に来るようにオフセット調整
    let scale = 1.0;
    let panX = (workspace.clientWidth - boardWidth) / 2;
    let panY = (workspace.clientHeight - boardHeight) / 2;

    function updateTransform() {
        requestAnimationFrame(() => {
            canvasContainer.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
            canvasContainer.style.transformOrigin = '0 0';
            document.getElementById('zoom-display').innerText = Math.round(scale * 100) + '%';
        });
    }
    updateTransform();

    document.getElementById('btn-zoom-in').onclick = () => { scale = Math.min(10.0, scale * 1.25); updateTransform(); };
    document.getElementById('btn-zoom-out').onclick = () => { scale = Math.max(0.05, scale / 1.25); updateTransform(); };
    document.getElementById('btn-reset-view').onclick = () => { 
        scale = 1.0; 
        panX = (workspace.clientWidth - boardWidth) / 2;
        panY = (workspace.clientHeight - boardHeight) / 2;
        updateTransform(); 
    };

    // マウスカーソル中心の滑らかなホイールズーム
    workspace.addEventListener('wheel', (e) => {
        e.preventDefault();
        const zoomFactor = e.deltaY < 0 ? 1.15 : 0.85;
        const newScale = Math.min(10.0, Math.max(0.05, scale * zoomFactor));
        
        const rect = workspace.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        panX = mouseX - (mouseX - panX) * (newScale / scale);
        panY = mouseY - (mouseY - panY) * (newScale / scale);
        scale = newScale;
        updateTransform();
    }, { passive: false });

    let isPanning = false;
    let startPanX = 0, startPanY = 0;

    workspace.addEventListener('mousedown', (e) => {
        const isPenActive = document.getElementById('btn-pen').classList.contains('active') || document.getElementById('btn-eraser').classList.contains('active');
        if (e.button === 2 || e.button === 1 || !isPenActive) {
            isPanning = true;
            startPanX = e.clientX - panX;
            startPanY = e.clientY - panY;
            e.preventDefault();
        }
    });

    window.addEventListener('mousemove', (e) => {
        if (isPanning) {
            panX = e.clientX - startPanX;
            panY = e.clientY - startPanY;
            updateTransform();
        }
    });

    window.addEventListener('mouseup', () => { isPanning = false; });
    workspace.addEventListener('contextmenu', (e) => e.preventDefault());

    function createLayer(name = `レイヤー ${layers.length + 1}`) {
        const id = 'layer_' + Math.random().toString(36).substring(2, 9);
        const canvas = document.createElement('canvas');
        canvas.id = id;
        canvas.className = 'layer-canvas';
        canvas.width = boardWidth;
        canvas.height = boardHeight;
        layersStack.appendChild(canvas);
        const layerObj = { id, name, canvas, ctx: canvas.getContext('2d', { alpha: true }) };
        layers.push(layerObj);
        setActiveLayer(id);
        updateLayerUI();
        saveState();
        return layerObj;
    }

    function setActiveLayer(id) {
        activeLayerId = id;
        layers.forEach(l => { l.canvas.style.zIndex = l.id === id ? '5' : '2'; });
        updateLayerUI();
    }

    window.deleteLayer = function(id) {
        if (layers.length <= 1) {
            alert('すべてのレイヤーを削除することはできません。');
            return;
        }
        const index = layers.findIndex(l => l.id === id);
        if (index !== -1) {
            layers[index].canvas.remove();
            layers.splice(index, 1);
            if (activeLayerId === id) {
                activeLayerId = layers[layers.length - 1].id;
            }
            updateLayerUI();
            saveState();
        }
    };

    function updateLayerUI() {
        const list = document.getElementById('layer-list');
        list.innerHTML = '';
        layers.slice().reverse().forEach(l => {
            const item = document.createElement('div');
            item.className = `layer-item ${l.id === activeLayerId ? 'active' : ''}`;
            item.style.display = 'flex';
            item.style.justifyContent = 'space-between';
            item.style.alignItems = 'center';
            item.style.padding = '6px';
            item.style.margin = '4px 0';
            item.style.background = l.id === activeLayerId ? '#2a472e' : '#222';
            item.style.borderRadius = '4px';
            item.style.cursor = 'pointer';

            item.innerHTML = `
                <span class="layer-name" style="flex-grow:1; color:#fff; font-size:12px;" onclick="setActiveLayer('${l.id}')">${l.name}</span>
                <div>
                    ${layers.length > 1 ? `<button onclick="deleteLayer('${l.id}')" style="background:none; border:none; cursor:pointer; font-size:14px; color:#ff5722;" title="削除">🗑️</button>` : ''}
                </div>
            `;
            list.appendChild(item);
        });
    }

    document.getElementById('btn-add-layer').onclick = () => createLayer(`レイヤー ${layers.length + 1}`);
    createLayer('レイヤー 1');

    function getActiveCtx() {
        const found = layers.find(l => l.id === activeLayerId);
        return found ? found.ctx : null;
    }

    function saveState() {
        const state = layers.map(l => l.canvas.toDataURL());
        undoStack.push(state);
        if (undoStack.length > 15) undoStack.shift();
        redoStack = [];
    }

    document.getElementById('btn-undo').onclick = () => {
        if (undoStack.length <= 1) return;
        redoStack.push(undoStack.pop());
        restoreState(undoStack[undoStack.length - 1]);
    };

    document.getElementById('btn-redo').onclick = () => {
        if (redoStack.length === 0) return;
        const nextState = redoStack.pop();
        undoStack.push(nextState);
        restoreState(nextState);
    };

    function restoreState(stateArr) {
        stateArr.forEach((dataUrl, idx) => {
            if (!layers[idx]) createLayer(`レイヤー ${idx + 1}`);
            const img = new Image();
            img.onload = () => {
                const ctx = layers[idx].ctx;
                ctx.clearRect(0, 0, boardWidth, boardHeight);
                ctx.drawImage(img, 0, 0);
            };
            img.src = dataUrl;
        });
    }

    let drawing = false;
    let points = [];
    let penColor = '#000000';
    let penSize = 8.0;
    let penOpacity = 1.0;
    let isEraser = false;
    let smoothedX = 0;
    let smoothedY = 0;

    document.getElementById('color-picker').oninput = (e) => penColor = e.target.value;
    document.getElementById('bg-color-picker').oninput = (e) => {
        bgCtx.fillStyle = e.target.value;
        bgCtx.fillRect(0, 0, boardWidth, boardHeight);
    };
    
    document.getElementById('btn-size-plus').onclick = () => { penSize = Math.min(50, penSize + 1); document.getElementById('size-display').innerText = penSize.toFixed(1); };
    document.getElementById('btn-size-minus').onclick = () => { penSize = Math.max(1, penSize - 1); document.getElementById('size-display').innerText = penSize.toFixed(1); };
    document.getElementById('btn-opacity-plus').onclick = () => { penOpacity = Math.min(1.0, penOpacity + 0.1); document.getElementById('opacity-display').innerText = penOpacity.toFixed(1); };
    document.getElementById('btn-opacity-minus').onclick = () => { penOpacity = Math.max(0.1, penOpacity - 0.1); document.getElementById('opacity-display').innerText = penOpacity.toFixed(1); };

    document.getElementById('btn-pen').onclick = () => { isEraser = false; document.getElementById('btn-pen').classList.add('active'); document.getElementById('btn-eraser').classList.remove('active'); };
    document.getElementById('btn-eraser').onclick = () => { isEraser = true; document.getElementById('btn-eraser').classList.add('active'); document.getElementById('btn-pen').classList.remove('active'); };

    const firstCanvas = layers[0].canvas;

    // 【座標ズレの完全修復】 transform（panX, panY, scale）を正確に逆算してキャンバス上の論理座標に変換
    function getCanvasPoint(e) {
        const rect = canvasContainer.getBoundingClientRect();
        return {
            x: (e.clientX - rect.left) / scale,
            y: (e.clientY - rect.top) / scale
        };
    }

    firstCanvas.addEventListener('mousedown', (e) => {
        if (e.button !== 0 || isPanning) return;
        drawing = true;
        const pt = getCanvasPoint(e);
        
        smoothedX = pt.x;
        smoothedY = pt.y;
        
        points = [{ x: smoothedX, y: smoothedY }];

        localDraftCtx.clearRect(0, 0, boardWidth, boardHeight);
        localDraftCanvas.style.opacity = penOpacity;
        
        socket.emit('draw', { state: 'start', user: currentUsername, opacity: penOpacity });
    });

    window.addEventListener('mouseup', () => {
        if (drawing) {
            const ctx = getActiveCtx();
            if (ctx) {
                ctx.globalAlpha = isEraser ? 1.0 : penOpacity;
                ctx.drawImage(localDraftCanvas, 0, 0);
                ctx.globalAlpha = 1.0;
            }
            localDraftCtx.clearRect(0, 0, boardWidth, boardHeight);
            
            socket.emit('draw', { state: 'end', user: currentUsername, layerId: activeLayerId, eraser: isEraser, opacity: penOpacity });

            drawing = false;
            points = [];
            saveState();
        }
    });

    firstCanvas.addEventListener('mousemove', (e) => {
        if (!drawing) return;
        const pt = getCanvasPoint(e);
        let rawX = pt.x;
        let rawY = pt.y;

        if (document.getElementById('ai-stroke-toggle').checked) {
            smoothedX += (rawX - smoothedX) * 0.4;
            smoothedY += (rawY - smoothedY) * 0.4;
        } else {
            smoothedX = rawX;
            smoothedY = rawY;
        }

        const lastP = points[points.length - 1];
        if (lastP && Math.hypot(smoothedX - lastP.x, smoothedY - lastP.y) < 0.5) return;

        points.push({ x: smoothedX, y: smoothedY });
        if (points.length < 2) return;

        const pPrev = points[points.length - 2];
        const pCurr = points[points.length - 1];

        localDraftCtx.strokeStyle = isEraser ? '#ffffff' : penColor;
        localDraftCtx.lineWidth = penSize;
        if (isEraser) {
            localDraftCtx.globalCompositeOperation = 'destination-out';
        } else {
            localDraftCtx.globalCompositeOperation = 'source-over';
        }
        localDraftCtx.lineCap = 'round';
        localDraftCtx.lineJoin = 'round';

        localDraftCtx.beginPath();
        localDraftCtx.moveTo(pPrev.x, pPrev.y);
        localDraftCtx.lineTo(pCurr.x, pCurr.y);
        localDraftCtx.stroke();
        localDraftCtx.closePath();

        socket.emit('draw', { 
            state: 'draw', user: currentUsername,
            x0: pPrev.x, y0: pPrev.y, x1: pCurr.x, y1: pCurr.y, 
            color: penColor, size: penSize, eraser: isEraser 
        });
    });

    socket.on('draw_sync', (data) => {
        if (data.state === 'start') {
            const remote = getRemoteDraft(data.user);
            remote.ctx.clearRect(0, 0, boardWidth, boardHeight);
            remote.canvas.style.opacity = data.opacity;
        } else if (data.state === 'end') {
            const remote = getRemoteDraft(data.user);
            const targetLayer = layers.find(l => l.id === data.layerId) || layers[0];
            targetLayer.ctx.globalAlpha = data.eraser ? 1.0 : data.opacity;
            if (data.eraser) targetLayer.ctx.globalCompositeOperation = 'destination-out';
            targetLayer.ctx.drawImage(remote.canvas, 0, 0);
            targetLayer.ctx.globalAlpha = 1.0;
            targetLayer.ctx.globalCompositeOperation = 'source-over';
            remote.ctx.clearRect(0, 0, boardWidth, boardHeight);
        } else if (data.state === 'draw') {
            const remote = getRemoteDraft(data.user);
            remote.ctx.strokeStyle = data.color;
            remote.ctx.lineWidth = data.size;
            if (data.eraser) {
                remote.ctx.globalCompositeOperation = 'destination-out';
            } else {
                remote.ctx.globalCompositeOperation = 'source-over';
            }
            remote.ctx.lineCap = 'round';
            remote.ctx.lineJoin = 'round';
            
            remote.ctx.beginPath();
            remote.ctx.moveTo(data.x0, data.y0);
            remote.ctx.lineTo(data.x1, data.y1);
            remote.ctx.stroke();
            remote.ctx.closePath();
        }
    });

    document.getElementById('btn-save').onclick = () => {
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = boardWidth;
        tempCanvas.height = boardHeight;
        const tempCtx = tempCanvas.getContext('2d');
        tempCtx.drawImage(bgCanvas, 0, 0);
        layers.forEach(l => tempCtx.drawImage(l.canvas, 0, 0));

        const link = document.createElement('a');
        link.download = 'whiteboard.png';
        link.href = tempCanvas.toDataURL();
        link.click();
    };
}

let localStream, peerConnection;
const rtcConfig = { 'iceServers': [{'urls': 'stun:stun.l.google.com:19302'}] };

async function initWebRTC() {
    document.getElementById('remote-box').style.display = 'none';

    try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        document.getElementById('localVideo').srcObject = localStream;
        setupSpeakerGate(localStream);
        setupSignaling();
    } catch(e) {
        console.warn("メディアデバイス取得失敗:", e);
    }
}

function setupSignaling() {
    peerConnection = new RTCPeerConnection(rtcConfig);
    localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

    peerConnection.ontrack = (event) => {
        const remoteVideo = document.getElementById('remoteVideo');
        if (remoteVideo.srcObject !== event.streams[0]) {
            remoteVideo.srcObject = event.streams[0];
            remoteVideo.play().catch(e => console.error("リモート音声再生エラー:", e));
        }
        document.getElementById('remote-box').style.display = 'block';
    };

    peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('webrtc_ice_candidate', { candidate: event.candidate, username: currentUsername });
        }
    };

    peerConnection.createOffer().then(offer => {
        peerConnection.setLocalDescription(offer);
        socket.emit('webrtc_offer', { sdp: offer, username: currentUsername });
    });

    socket.on('webrtc_offer', async (data) => {
        if (data.username) {
            document.getElementById('remote-user-name').innerText = data.username;
        }
        await peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp));
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        socket.emit('webrtc_answer', { sdp: answer, username: currentUsername });
    });

    socket.on('webrtc_answer', async (data) => {
        if (data.username) {
            document.getElementById('remote-user-name').innerText = data.username;
        }
        await peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp));
    });

    socket.on('webrtc_ice_candidate', async (data) => {
        try { await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch(e){}
    });
}

function setupSpeakerGate(stream) {
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const analyser = audioCtx.createAnalyser();
    const source = audioCtx.createMediaStreamSource(stream);
    source.connect(analyser);
    analyser.fftSize = 256;
    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    
    const audioTrack = stream.getAudioTracks()[0];
    let isManualMuted = false;
    let holdTimer = null;
    let isSpeaking = false;
    
    document.getElementById('btn-toggle-mic').onclick = function() {
        if (!audioTrack) return;
        isManualMuted = !isManualMuted;
        this.classList.toggle('active', !isManualMuted);
        audioTrack.enabled = !isManualMuted;
        if (isManualMuted) {
            document.getElementById('local-box').classList.remove('speaking');
        }
    };

    setInterval(() => {
        if (isManualMuted || !audioTrack) return; 
        analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for(let i = 2; i < 40; i++) sum += dataArray[i];
        
        const localBox = document.getElementById('local-box');
        const THRESHOLD = 350; 
        
        if (sum > THRESHOLD) {
            isSpeaking = true;
            localBox.classList.add('speaking');
            audioTrack.enabled = true; 
            if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
        } else {
            if (isSpeaking && !holdTimer) {
                holdTimer = setTimeout(() => {
                    isSpeaking = false;
                    localBox.classList.remove('speaking');
                }, 1000); 
            }
        }
    }, 50);
}

function initChat() {
    const chatPanel = document.getElementById('chat-panel');
    const chatMsgs = document.getElementById('chat-messages');
    const chatInput = document.getElementById('input-chat');
    let aiTimeoutTimer = null;

    document.getElementById('btn-toggle-chat').onclick = () => {
        chatPanel.classList.toggle('hidden');
    };

    const sendMessageAction = () => {
        const txt = chatInput.value.trim();
        if(txt) {
            socket.emit('send_message', { message: txt, file: null, file_type: '', file_name: '' });
            chatInput.value = '';
            chatInput.style.height = 'auto';
        }
    };

    document.getElementById('btn-send-chat').onclick = sendMessageAction;

    chatInput.addEventListener('input', function() {
        this.style.height = 'auto';
        this.style.height = Math.min(this.scrollHeight, 120) + 'px';
    });

    chatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            sendMessageAction();
        }
    });

    const btnAttach = document.getElementById('btn-attach-file');
    const inputFile = document.getElementById('input-file');
    btnAttach.onclick = () => inputFile.click();

    inputFile.onchange = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();

        reader.onload = (ev) => {
            socket.emit('send_message', { 
                message: `ファイルを送信しました: ${file.name}`, 
                file: ev.target.result, 
                file_type: file.type || '',
                file_name: file.name 
            });
        };
        reader.readAsDataURL(file);
        inputFile.value = ''; 
    };

    // AIアドバイザー呼び出し機能（タイムアウトを90秒に延長し余裕を持たせる）
    document.getElementById('btn-ai-consult').onclick = () => {
        let txt = chatInput.value.trim();
        if (!txt) {
            txt = "こんにちは！ブレインストーミングの提案をしてください。";
        }

        socket.emit('ask_ai', { prompt: txt });
        
        chatMsgs.innerHTML += `
            <div class="chat-msg other" id="ai-thinking-indicator">
                <span class="chat-sender">🤖 AIアドバイザー</span>
                <div class="chat-bubble-container">
                    <div class="chat-bubble">情報を検索・思考中...</div>
                </div>
            </div>`;
        chatMsgs.scrollTop = chatMsgs.scrollHeight;
        chatInput.value = ''; 
        chatInput.style.height = 'auto';

        if (aiTimeoutTimer) clearTimeout(aiTimeoutTimer);
        
        aiTimeoutTimer = setTimeout(() => {
            const indicator = document.getElementById('ai-thinking-indicator');
            if (indicator) {
                indicator.remove();
                chatMsgs.innerHTML += `
                    <div class="chat-msg other">
                        <span class="chat-sender">🤖 AIアドバイザー</span>
                        <div class="chat-bubble-container">
                            <div class="chat-bubble" style="color: #ff9800;">処理に時間がかかっていますが、まもなく応答します...</div>
                        </div>
                    </div>`;
                chatMsgs.scrollTop = chatMsgs.scrollHeight;
            }
        }, 90000);
    };

    // グループチャットのメッセージ未表示バグを完全に修正
    socket.on('receive_message', (data) => {
        const thinkingIndicator = document.getElementById('ai-thinking-indicator');
        if (thinkingIndicator && data.user.includes('AI')) {
            thinkingIndicator.remove();
            if (aiTimeoutTimer) clearTimeout(aiTimeoutTimer);
        }

        const isMine = data.user === currentUsername;
        const msgDiv = document.createElement('div');
        msgDiv.className = `chat-msg ${isMine ? 'mine' : 'other'}`;
        msgDiv.id = `msg-${data.id}`;

        let safeMessage = '';
        if (data.message) {
            safeMessage = String(data.message)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;')
                .replace(/\n/g, '<br>');
        }

        let content = safeMessage ? `<span>${safeMessage}</span>` : '';
        
        if (data.file) {
            const fileName = data.file_name || 'download_file';
            if (data.file_type && data.file_type.startsWith('image/')) {
                content += `<div style="margin-top:5px;"><img src="${data.file}" style="max-width: 100%; border-radius: 4px;"><br><a href="${data.file}" download="${fileName}" style="color: #4CAF50; font-size: 11px; text-decoration: underline; display:inline-block; margin-top:4px;">⬇️ 画像をダウンロード</a></div>`;
            } else {
                content += `<div style="margin-top:5px;"><a href="${data.file}" download="${fileName}" style="background: #007bff; color: white; padding: 6px 12px; border-radius: 4px; font-size: 12px; text-decoration: none; display: inline-block; font-weight: bold;">📥 ${fileName} をダウンロード</a></div>`;
            }
        }

        let deleteBtnHTML = isMine && data.id ? `<button onclick="deleteMessage(${data.id})" style="background:none; border:none; color:#ff5722; font-size:10px; cursor:pointer; padding:0; margin-left:6px;" title="削除">🗑️ 削除</button>` : '';
        let readCountHTML = `<span style="font-size:10px; color:#aaa; margin-left:4px;">既読 ${data.read_count || 1}</span>`;

        msgDiv.innerHTML = `
            <span class="chat-sender">${data.user}</span>
            <div class="chat-bubble-container">
                <div class="chat-bubble">${content}</div>
                <div style="display:flex; flex-direction:column; align-items:flex-end;">
                    ${readCountHTML}
                    ${deleteBtnHTML}
                </div>
            </div>`;
        chatMsgs.appendChild(msgDiv);
        chatMsgs.scrollTop = chatMsgs.scrollHeight;
    });

    socket.on('message_deleted', (data) => {
        const target = document.getElementById(`msg-${data.id}`);
        if (target) {
            const bubble = target.querySelector('.chat-bubble');
            if (bubble) bubble.innerHTML = '<span style="color:#888; font-style:italic;">このメッセージは削除されました</span>';
        }
    });
}

window.deleteMessage = function(id) {
    if (confirm('このメッセージを削除しますか？')) {
        socket.emit('delete_message', { id: id });
    }
};

function initLayoutAndDrag() {
    const gallery = document.getElementById('video-gallery');
    const container = document.getElementById('video-chat-container');
    const mainContent = document.getElementById('main-content');
    let layoutMode = 'wipe';

    document.getElementById('btn-toggle-layout').onclick = () => {
        if (layoutMode === 'wipe') {
            layoutMode = 'sidebar';
            gallery.className = 'sidebar-mode';
            mainContent.classList.remove('top-layout');
            gallery.style.cssText = '';
        } else if (layoutMode === 'sidebar') {
            layoutMode = 'top';
            gallery.className = 'top-mode';
            mainContent.classList.add('top-layout');
            gallery.style.cssText = '';
        } else {
            layoutMode = 'wipe';
            gallery.className = 'wipe-mode';
            mainContent.classList.remove('top-layout');
            gallery.style.top = '15px';
            gallery.style.right = '20px';
            gallery.style.left = 'auto';
            gallery.style.bottom = 'auto';
        }
    };

    let isDragging = false, startX, startY;
    container.addEventListener('mousedown', (e) => {
        if (layoutMode !== 'wipe') return;
        isDragging = true;
        startX = e.clientX - gallery.offsetLeft;
        startY = e.clientY - gallery.offsetTop;
    });

    window.addEventListener('mousemove', (e) => {
        if (!isDragging || layoutMode !== 'wipe') return;
        gallery.style.left = (e.clientX - startX) + 'px';
        gallery.style.top = (e.clientY - startY) + 'px';
        gallery.style.right = 'auto';
    });

    window.addEventListener('mouseup', () => { isDragging = false; });

    document.getElementById('btn-toggle-cam').onclick = function() {
        if (!localStream) return;
        const videoTrack = localStream.getVideoTracks()[0];
        if (videoTrack) {
            videoTrack.enabled = !videoTrack.enabled;
            this.classList.toggle('active', videoTrack.enabled);
            document.getElementById('local-box').classList.toggle('video-off', !videoTrack.enabled);
        }
    };

    document.getElementById('btn-toggle-noise').onclick = function() {
        this.classList.toggle('active');
        this.style.background = this.classList.contains('active') ? '#27ae60' : '#444';
        this.innerText = this.classList.contains('active') ? 'ON' : 'OFF';
    };

    document.getElementById('btn-toggle-panel').onclick = () => {
        document.getElementById('layer-panel').classList.toggle('hidden');
    };

    document.getElementById('btn-leave').onclick = () => {
        window.location.href = '/logout';
    };

    document.getElementById('btn-copy-url').onclick = () => {
        navigator.clipboard.writeText(window.location.href);
        alert('招待URLをコピーしました！');
    };
}