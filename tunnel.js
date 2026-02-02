const net = require('net');

// Cấu hình từ biến môi trường (Environment Variables)
const SERVICE_ID = process.env.TUNNEL_SERVICE || 'rdp';
const LOCAL_PORT = parseInt(process.env.TUNNEL_LOCAL_PORT) || 3389;
const REMOTE_HOST = process.env.TUNNEL_REMOTE_HOST;
const REMOTE_PORT = parseInt(process.env.TUNNEL_REMOTE_PORT);
const SECRET_KEY = process.env.TUNNEL_SECRET; // Lấy từ GitHub Secret

if (!REMOTE_HOST || !REMOTE_PORT || !SECRET_KEY) {
  console.error("Thiếu cấu hình: REMOTE_HOST, REMOTE_PORT hoặc TUNNEL_SECRET!");
  process.exit(1);
}

let controlSocket = null;
let heartbeatTimer = null;

function createControlConnection() {
  console.log(`[SYSTEM] Đang kết nối tunnel cho dịch vụ: ${SERVICE_ID}`);
  
  controlSocket = net.connect({
    host: REMOTE_HOST,
    port: REMOTE_PORT
  }, () => {
    console.log('[CONTROL] Đã kết nối tới server trung gian.');
    // Gửi định danh kèm Secret Key để xác thực
    controlSocket.write(`TUNNEL|${SERVICE_ID}|${SECRET_KEY}\n`);
  });

  controlSocket.on('data', (data) => {
    const msg = data.toString();
    
    if (msg.startsWith('OK')) {
      console.log(`\n✅ TUNNEL ACTIVE`);
      console.log(`Dịch vụ: ${SERVICE_ID} (localhost:${LOCAL_PORT})`);
      console.log(`Công khai: ${REMOTE_HOST}:${REMOTE_PORT}\n`);
      
      startHeartbeat(); // Bắt đầu gửi PING định kỳ
      listenForNewConnections();
    } else if (msg.startsWith('ERROR')) {
      console.error(`[AUTH] Lỗi xác thực: ${msg.trim()}`);
      process.exit(1); // Sai Secret Key thì dừng luôn
    }
  });

  controlSocket.on('error', (err) => {
    console.error('[CONTROL] Lỗi:', err.message);
  });

  controlSocket.on('close', () => {
    console.log('[CONTROL] Kết nối bị ngắt. Đang thử lại sau 5 giây...');
    stopHeartbeat();
    setTimeout(createControlConnection, 5000);
  });
}

// Cơ chế Heartbeat để giữ server trung gian không bị timeout
function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (controlSocket && controlSocket.writable) {
      controlSocket.write('PING\n');
    }
  }, 10000); // Gửi PING mỗi 10 giây
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function listenForNewConnections() {
  let buffer = Buffer.alloc(0);
  
  controlSocket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).toString('utf8');
      buffer = buffer.slice(idx + 1);
      
      const [cmd, connId] = line.split('|');
      if (cmd === 'NEW') {
        console.log(`[CLIENT] Kết nối mới: ${connId}`);
        handleNewConnection(connId);
      }
    }
  });
}

function handleNewConnection(connId) {
  // 1. Kết nối tới dịch vụ local (RDP/SSH)
  const localSocket = net.connect({
    host: '127.0.0.1',
    port: LOCAL_PORT
  }, () => {
    // 2. Kết nối tới server trung gian để làm đường truyền dữ liệu (Data Bridge)
    const dataSocket = net.connect({
      host: REMOTE_HOST,
      port: REMOTE_PORT
    }, () => {
      // Gửi header DATA để server trung gian biết đây là luồng dữ liệu của connId nào
      dataSocket.write(`DATA|${SERVICE_ID}|${connId}\n`);
      
      // Nối ống dữ liệu hai chiều
      localSocket.pipe(dataSocket);
      dataSocket.pipe(localSocket);
    });
    
    dataSocket.on('error', () => localSocket.destroy());
    localSocket.on('error', () => dataSocket.destroy());
  });
}

createControlConnection();
