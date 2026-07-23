'use strict';

const socket = io();

const username = document.getElementById('input-username').value;
let roomId = document.getElementById('input-room-id').value.trim();

// 無限キャンパス・ビュー状態管理
let scale = 1.0;
let panX = 0;
let panY = 0;
let isPanning = false;
let startX = 0;
let startY = 0;

let isDrawing = false;
let lastX = 0;
let lastY = 0;
let currentTool = 'pen';
let penType = 'digital';
let penColor = '#000000';
let penSize = 8.0;
let penOpacity = 1.0;
let bgColor = '#ffffff';

// レイヤー管理
let layers = [];
let activeLayerId = null;
let layerCounter = 0;

// DOM要素
const joinModal = document.getElementById('join-modal');
const appContainer = document.getElementById('app-container');
const btnJoin = document.getElementById('btn-join');
const inputRoomId = document.getElementById('input-room-id');
const roomIdDisplay = document.getElementById('room-id-display');
const btnCopyUrl = document.getElementById('btn-copy-url');

const canvasContainer = document.getElementById('canvas-container');
const layersStack = document.getElementById('layers-stack');
const layerBg = document.getElementById('layer-bg');
const bgCtx = layerBg.getContext('2d');
const workspace = document.getElementById('workspace');

const btnPen = document.getElementById('btn-pen');
const btnEraser = document.getElementById('btn-eraser');
const colorPicker = document.getElementById('color-picker');
const bgColorPicker = document.getElementById('bg-color-picker');
const btnSizePlus = document.getElementById('btn-size-plus');
const btnSizeMinus = document.getElementById('btn-size-minus');
const sizeDisplay = document.getElementById('size-display');
const btnOpacityPlus = document.getElementById('btn-opacity-plus');
const btnOpacityMinus = document.getElementById('btn-opacity-minus');
const opacityDisplay = document.getElementById('opacity-display');

const btnZoomIn = document.getElementById('btn-zoom-in');
const btnZoomOut = document.getElementById('btn-zoom-out');
const zoomDisplay = document.getElementById('zoom-display');
const btnResetView = document.getElementById('btn-reset-view');

const chatPanel = document.getElementById('chat-panel');
const layerPanel = document.getElementById('layer-panel');
const btnToggleChat = document.getElementById('btn-toggle-chat');
const btnTogglePanel = document.getElementById('btn-toggle-panel');
const btnAiConsult = document.getElementById('btn-ai-consult');
const chatMessages = document.getElementById('chat-messages');
const inputChat = document.getElementById('input-chat');
const btnSendChat = document.getElementById('btn-send-chat');

window.addEventListener('load', () => {
    const urlParams = new URLSearchParams(window.location.search);
    const urlRoom = urlParams.get('room');
    if (urlRoom) inputRoomId.value = urlRoom;
});

btnJoin.addEventListener('click', () => {
    roomId = inputRoomId.value.trim() || Math.floor(1000 + Math.random() * 9000).toString();
    roomIdDisplay.textContent = `ルームID: ${roomId}`;
    joinModal.style.display = 'none';
    appContainer.style.display = 'block';

    initCanvasSystem();
    initMediaStream();
    socket.emit('join', { room: roomId });
});

btnCopyUrl.addEventListener('click', () => {
    const shareUrl = `${window.location.origin}${window.location.pathname}?room=${roomId}`;
    navigator.clipboard.writeText(shareUrl).then(() => alert('招待URLをコピーしました！'));
});

// 無限キャンパス＆スムーズなズームパン
function initCanvasSystem() {
    resizeCanvasBackground();
    window.addEventListener('resize', resizeCanvasBackground);

    addNewLayer('背景レイヤー', true);
    addNewLayer('メインレイヤー', false);

    workspace.addEventListener('wheel', (e) => {
        e.preventDefault();
        const zoomFactor = 1.15;
        let newScale = e.deltaY < 0 ? scale * zoomFactor : scale / zoomFactor;
        newScale = Math.max(0.1, Math.min(10.0, newScale));

        const rect = workspace.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        panX = mouseX - (mouseX - panX) * (newScale / scale);
        panY = mouseY - (mouseY - panY) * (newScale / scale);
        scale = newScale;

        updateCanvasTransform();
    }, { passive: false });

    workspace.addEventListener('mousedown', (e) => {
        if (e.button === 2 || e.altKey || e.target === workspace || e.target === layerBg || e.target.id === 'guide-overlay') {
            isPanning = true;
            startX = e.clientX - panX;
            startY = e.clientY - panY;
            workspace.style.cursor = 'grab';
        }
    });

    window.addEventListener('mousemove', (e) => {
        if (isPanning) {
            panX = e.clientX - startX;
            panY = e.clientY - startY;
            updateCanvasTransform();
        }
    });

    window.addEventListener('mouseup', () => {
        isPanning = false;
        workspace.style.cursor = 'default';
    });

    workspace.addEventListener('contextmenu', (e) => e.preventDefault());
}

function resizeCanvasBackground() {
    layerBg.width = window.innerWidth;
    layerBg.height = window.innerHeight;
    bgCtx.fillStyle = bgColor;
    bgCtx.fillRect(0, 0, layerBg.width, layerBg.height);
}

function updateCanvasTransform() {
    zoomDisplay.textContent = `${Math.round(scale * 100)}%`;
    canvasContainer.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
    canvasContainer.style.transformOrigin = '0 0';
}

btnZoomIn.addEventListener('click', () => { scale = Math.min(10.0, scale * 1.25); updateCanvasTransform(); });
btnZoomOut.addEventListener('click', () => { scale = Math.max(0.1, scale / 1.25); updateCanvasTransform(); });
btnResetView.addEventListener('click', () => { scale = 1.0; panX = 0; panY = 0; updateCanvasTransform(); });

// レイヤー管理＆削除機能
function addNewLayer(name, isBg = false) {
    const layerId = `layer_${layerCounter++}`;
    const canvas = document.createElement('canvas');
    canvas.width = 3000;
    canvas.height = 2000;
    canvas.className = 'draw-layer';
    canvas.id = layerId;

    layersStack.appendChild(canvas);
    const ctx = canvas.getContext('2d', { alpha: true });
    layers.push({ id: layerId, name: name, canvas: canvas, ctx: ctx, visible: true, isBg: isBg });

    if (!isBg || activeLayerId === null) {
        setActiveLayer(layerId);
    }
    updateLayerListUI();
}

function setActiveLayer(layerId) {
    activeLayerId = layerId;
    updateLayerListUI();
}

function updateLayerListUI() {
    const layerList = document.getElementById('layer-list');
    layerList.innerHTML = '';
    layers.slice().reverse().forEach(layer => {
        const item = document.createElement('div');
        item.className = `layer-item ${layer.id === activeLayerId ? 'active' : ''}`;
        item.style.display = 'flex';
        item.style.justifyContent = 'space-between';
        item.style.alignItems = 'center';
        item.style.padding = '4px 8px';
        item.style.marginBottom = '4px';
        item.style.background = layer.id === activeLayerId ? '#2a4736' : '#222';

        item.innerHTML = `
            <span style="cursor:pointer; flex-grow:1;" onclick="setActiveLayerFromUI('${layer.id}')">${layer.name}</span>
            <div>
                <button onclick="toggleLayerVisibility('${layer.id}')" style="background:none; border:none; cursor:pointer;" title="表示切替">${layer.visible ? '👁️' : '🚫'}</button>
                ${!layer.isBg ? `<button onclick="deleteLayer('${layer.id}')" style="background:none; border:none; cursor:pointer; color:#ff5555;" title="削除">🗑️</button>` : ''}
            </div>
        `;
        layerList.appendChild(item);
    });
}

window.setActiveLayerFromUI = (id) => setActiveLayer(id);

window.toggleLayerVisibility = function(layerId) {
    const layer = layers.find(l => l.id === layerId);
    if (layer) {
        layer.visible = !layer.visible;
        layer.canvas.style.display = layer.visible ? 'block' : 'none';
        updateLayerListUI();
    }
}

window.deleteLayer = function(layerId) {
    if (layers.length <= 1) {
        alert('すべてのレイヤーを削除することはできません。');
        return;
    }
    const index = layers.findIndex(l => l.id === layerId);
    if (index !== -1) {
        layers[index].canvas.remove();
        layers.splice(index, 1);
        if (activeLayerId === layerId) {
            activeLayerId = layers[layers.length - 1].id;
        }
        updateLayerListUI();
    }
}

document.getElementById('btn-add-layer').addEventListener('click', () => {
    addNewLayer(`レイヤー ${layers.length}`);
});

// 正確なスケーリング描画
function getActiveCtx() {
    const active = layers.find(l => l.id === activeLayerId);
    return active ? active.ctx : null;
}

function getActiveCanvas() {
    const active = layers.find(l => l.id === activeLayerId);
    return active ? active.canvas : null;
}

layersStack.addEventListener('mousedown', (e) => {
    if (isPanning) return;
    const canvas = getActiveCanvas();
    if (!canvas) return;

    isDrawing = true;
    const rect = canvas.getBoundingClientRect();
    lastX = (e.clientX - rect.left) / scale;
    lastY = (e.clientY - rect.top) / scale;
});

layersStack.addEventListener('mousemove', (e) => {
    if (!isDrawing || isPanning) return;
    const canvas = getActiveCanvas();
    const ctx = getActiveCtx();
    if (!canvas || !ctx) return;

    const rect = canvas.getBoundingClientRect();
    const currentX = (e.clientX - rect.left) / scale;
    const currentY = (e.clientY - rect.top) / scale;

    ctx.beginPath();
    ctx.moveTo(lastX, lastY);
    ctx.lineTo(currentX, currentY);

    if (currentTool === 'eraser') {
        ctx.globalCompositeOperation = 'destination-out';
        ctx.lineWidth = penSize * 2;
    } else {
        ctx.globalCompositeOperation = 'source-over';
        ctx.strokeStyle = penColor;
        ctx.lineWidth = penSize;
        ctx.globalAlpha = penOpacity;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
    }
    ctx.stroke();

    socket.emit('draw', {
        x0: lastX, y0: lastY, x1: currentX, y1: currentY,
        color: penColor, size: penSize, tool: currentTool, layerId: activeLayerId
    });

    lastX = currentX;
    lastY = currentY;
});

window.addEventListener('mouseup', () => { isDrawing = false; });

socket.on('draw_sync', (data) => {
    const targetLayer = layers.find(l => l.id === data.layerId);
    if (!targetLayer) return;
    const ctx = targetLayer.ctx;

    ctx.beginPath();
    ctx.moveTo(data.x0, data.y0);
    ctx.lineTo(data.x1, data.y1);
    if (data.tool === 'eraser') {
        ctx.globalCompositeOperation = 'destination-out';
        ctx.lineWidth = data.size * 2;
    } else {
        ctx.globalCompositeOperation = 'source-over';
        ctx.strokeStyle = data.color;
        ctx.lineWidth = data.size;
    }
    ctx.stroke();
});

// ツール操作
btnPen.addEventListener('click', () => { currentTool = 'pen'; btnPen.classList.add('active'); btnEraser.classList.remove('active'); });
btnEraser.addEventListener('click', () => { currentTool = 'eraser'; btnEraser.classList.add('active'); btnPen.classList.remove('active'); });
colorPicker.addEventListener('input', (e) => penColor = e.target.value);
bgColorPicker.addEventListener('input', (e) => {
    bgColor = e.target.value;
    resizeCanvasBackground();
});

btnSizePlus.addEventListener('click', () => { penSize = Math.min(100, penSize + 1); sizeDisplay.textContent = penSize.toFixed(1); });
btnSizeMinus.addEventListener('click', () => { penSize = Math.max(1, penSize - 1); sizeDisplay.textContent = penSize.toFixed(1); });
btnOpacityPlus.addEventListener('click', () => { penOpacity = Math.min(1.0, penOpacity + 0.1); opacityDisplay.textContent = penOpacity.toFixed(1); });
btnOpacityMinus.addEventListener('click', () => { penOpacity = Math.max(0.1, penOpacity - 0.1); opacityDisplay.textContent = penOpacity.toFixed(1); });

// チャット＆AIアドバイザー機能（修正・確実な表示）
btnToggleChat.addEventListener('click', () => chatPanel.classList.toggle('hidden'));
btnTogglePanel.addEventListener('click', () => layerPanel.classList.toggle('hidden'));

btnSendChat.addEventListener('click', sendChatMessage);
inputChat.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendChatMessage();
    }
});

function sendChatMessage() {
    const text = inputChat.value.trim();
    if (!text) return;
    socket.emit('send_message', { message: text });
    inputChat.value = '';
}

btnAiConsult.addEventListener('click', () => {
    const promptText = prompt('AIアドバイザーへの質問やテーマを入力してください:', 'このプロジェクトの改善点を教えて');
    if (promptText) {
        const loadingDiv = document.createElement('div');
        loadingDiv.className = 'chat-message';
        loadingDiv.innerHTML = `<strong>🤖 AIアドバイザー</strong>: 情報を検索・思考中...`;
        chatMessages.appendChild(loadingDiv);
        chatMessages.scrollTop = chatMessages.scrollHeight;

        socket.emit('ask_ai', { prompt: promptText });
    }
});

socket.on('receive_message', (data) => {
    const msgDiv = document.createElement('div');
    msgDiv.className = `chat-message ${data.user === username ? 'self' : ''}`;
    msgDiv.innerHTML = `<strong>${data.user}</strong>: ${data.message}`;
    chatMessages.appendChild(msgDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;
});

// WebRTC
async function initMediaStream() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        document.getElementById('localVideo').srcObject = stream;
    } catch (e) {
        console.warn('カメラ・マイクの取得スキップ');
    }
}