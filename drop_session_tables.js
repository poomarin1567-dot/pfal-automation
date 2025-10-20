const pool = require('./db');

async function dropSessionTables() {
  try {
    console.log('🗑️ กำลังลบตารางที่เกี่ยวกับ session...');

    // ลบ foreign key constraints ก่อน (ถ้ามี)
    await pool.query(`
      ALTER TABLE IF EXISTS user_sessions 
      DROP CONSTRAINT IF EXISTS user_sessions_user_id_fkey;
    `);

    await pool.query(`
      ALTER TABLE IF EXISTS activity_logs 
      DROP CONSTRAINT IF EXISTS activity_logs_user_id_fkey;
    `);

    // ลบตาราง user_sessions
    await pool.query('DROP TABLE IF EXISTS user_sessions CASCADE;');
    console.log('✅ ลบตาราง user_sessions แล้ว');

    // ลบตาราง activity_logs
    await pool.query('DROP TABLE IF EXISTS activity_logs CASCADE;');
    console.log('✅ ลบตาราง activity_logs แล้ว');

    // ตรวจสอบตารางที่เหลือ
    const result = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name IN ('users', 'user_sessions', 'activity_logs')
      ORDER BY table_name;
    `);
    
    console.log('📋 ตารางที่เหลือ:', result.rows);
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

dropSessionTables();