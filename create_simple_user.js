const { Pool } = require('pg');

// Database connection
const pool = new Pool({
  host: '192.168.20.50',
  port: 5432,
  user: 'postgres',
  password: '123456',
  database: 'pfal'
});

async function createSimpleUser() {
  try {
    console.log('🔄 สร้างผู้ใช้ทดสอบ...');
    
    // ลบผู้ใช้เก่า
    await pool.query('DELETE FROM users WHERE username = $1', ['testadmin']);
    
    // สร้างผู้ใช้ใหม่โดยใช้ plaintext password (เพื่อทดสอบ)
    const result = await pool.query(`
      INSERT INTO users (username, password_hash, role) 
      VALUES ($1, $2, $3)
      RETURNING id, username, role
    `, ['testadmin', 'plaintext_password_for_testing', 'admin']);
    
    console.log('✅ สำเร็จ! ผู้ใช้ทดสอบถูกสร้างแล้ว');
    console.log('📋 ข้อมูล:');
    console.log('   Username: testadmin');
    console.log('   Password: [จะแก้ใน API]');
    console.log('   Role:', result.rows[0].role);
    
  } catch (error) {
    console.error('❌ เกิดข้อผิดพลาด:', error.message);
  } finally {
    await pool.end();
  }
}

createSimpleUser();