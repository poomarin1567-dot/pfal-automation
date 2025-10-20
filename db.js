require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,
  max: 30,  // ✅ เพิ่มเป็น 30 สำหรับ 5 stations (6 connections/station)
  min: 5,   // ✅ เพิ่มเป็น 5 เพื่อ ready รับงาน
  idleTimeoutMillis: 30000, // ✅ เพิ่มเป็น 30 วินาที (reuse connections)
  connectionTimeoutMillis: 5000, // ✅ เพิ่มเป็น 5 วินาที
  statement_timeout: 20000, // ✅ เพิ่มเป็น 20 วินาที
  query_timeout: 20000,     // ✅ เพิ่มเป็น 20 วินาที
  acquireTimeoutMillis: 5000, // ✅ เพิ่มเป็น 5 วินาที
  keepAlive: true,          // ✅ เปิด keepAlive เพื่อ maintain connections
  keepAliveInitialDelayMillis: 10000, // ✅ ส่ง keepalive ทุก 10 วินาที
});

let isConnected = false;

pool.on('connect', () => {
  if (!isConnected) {
    console.log('✅ Database connected');
    isConnected = true;
  }
});

pool.on('error', (err) => {
  console.error('❌ Database connection error:', err);
});

// ✅ Auto cleanup connections every 30 seconds
setInterval(async () => {
  try {
    const client = await pool.connect();
    await client.query('SELECT 1'); // Keep alive test
    client.release();
    console.log(`📊 DB Pool: total=${pool.totalCount}, idle=${pool.idleCount}`);
  } catch (err) {
    console.error('DB cleanup error:', err.message);
  }
}, 30000);

// ✅ Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('🔄 Closing database connections...');
  await pool.end();
});

process.on('SIGINT', async () => {
  console.log('🔄 Closing database connections...');
  await pool.end();
  process.exit(0);
});

module.exports = pool;
