const { Pool } = require('pg');

const pool = new Pool({
  host: '192.168.20.50',
  port: 5432,
  user: 'postgres',
  password: '123456',
  database: 'pfal'
});

async function createSessionsTable() {
  try {
    console.log('🔄 สร้างตาราง user_sessions...');
    
    // สร้างตาราง user_sessions
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_sessions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        session_id VARCHAR(255) UNIQUE NOT NULL,
        login_time TIMESTAMP DEFAULT NOW(),
        last_activity TIMESTAMP DEFAULT NOW(),
        ip_address VARCHAR(45),
        user_agent TEXT,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    
    // สร้าง index สำหรับประสิทธิภาพ
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_user_sessions_session_id ON user_sessions(session_id);
      CREATE INDEX IF NOT EXISTS idx_user_sessions_is_active ON user_sessions(is_active);
    `);
    
    console.log('✅ สร้างตาราง user_sessions สำเร็จ!');
    console.log('📋 โครงสร้างตาราง:');
    console.log('   - user_id: เชื่อมโยงกับตาราง users');
    console.log('   - session_id: รหัส session ที่ไม่ซ้ำ');
    console.log('   - login_time: เวลาที่เข้าสู่ระบบ');
    console.log('   - last_activity: เวลาที่ใช้งานล่าสุด');
    console.log('   - ip_address: IP ที่เข้าใช้งาน');
    console.log('   - is_active: สถานะการใช้งาน');
    
  } catch (error) {
    console.error('❌ เกิดข้อผิดพลาด:', error.message);
  } finally {
    await pool.end();
  }
}

createSessionsTable();