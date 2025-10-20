const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,
});

async function clearAllSessions() {
  try {
    console.log('=== ล้าง Sessions ทั้งหมด ===');
    
    // ตั้งค่า session ทั้งหมดให้เป็น inactive
    const result = await pool.query(`
      UPDATE user_sessions 
      SET is_active = FALSE, updated_at = NOW() 
      WHERE is_active = TRUE
    `);
    
    console.log(`✅ ล้าง ${result.rowCount} active sessions สำเร็จ`);
    
    // ตรวจสอบอีกครั้ง
    const checkResult = await pool.query(`
      SELECT COUNT(*) as count 
      FROM user_sessions 
      WHERE is_active = TRUE
    `);
    
    console.log(`📊 Active sessions ที่เหลือ: ${checkResult.rows[0].count}`);
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await pool.end();
  }
}

clearAllSessions();