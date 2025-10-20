const { Pool } = require('pg');
const pool = new Pool({
  host: '192.168.20.50',
  port: 5432,
  user: 'postgres',
  password: '123456',
  database: 'pfal'
});

async function findRealOutboundData() {
  const client = await pool.connect();
  try {
    console.log('🔍 หาข้อมูล outbound จริงที่มีอยู่...');
    
    // หา task_monitor ที่เป็น outbound และ success
    const outboundTasks = await client.query(`
      SELECT tray_id, floor, slot, username, created_at, completed_at
      FROM task_monitor 
      WHERE action_type = 'outbound' AND status = 'success'
      ORDER BY completed_at DESC
      LIMIT 10
    `);
    
    console.log(`📤 พบ outbound tasks: ${outboundTasks.rows.length} รายการ`);
    outboundTasks.rows.forEach(task => {
      console.log(`- Tray ${task.tray_id}: ชั้น ${task.floor}, ช่อง ${task.slot} โดย ${task.username} (${task.completed_at})`);
    });
    
    // หา tray ที่ถูกนำออกแล้ว (ไม่อยู่ใน tray_inventory)
    const removedTrays = await client.query(`
      SELECT DISTINCT tm.tray_id, tm.floor, tm.slot, tm.username, tm.completed_at
      FROM task_monitor tm
      WHERE tm.action_type = 'outbound' 
        AND tm.status = 'success'
        AND tm.tray_id NOT IN (SELECT tray_id FROM tray_inventory WHERE tray_id IS NOT NULL)
      ORDER BY tm.completed_at DESC
      LIMIT 5
    `);
    
    console.log(`\n🗑️ ถาดที่นำออกแล้ว (ไม่อยู่ใน inventory): ${removedTrays.rows.length} ถาด`);
    removedTrays.rows.forEach(tray => {
      console.log(`- ${tray.tray_id}: ชั้น ${tray.floor}, ช่อง ${tray.slot} โดย ${tray.username}`);
    });
    
    // หา planting plan ที่เคยมี tray เหล่านี้ (จาก history)
    if (outboundTasks.rows.length > 0) {
      console.log('\n🔗 กำลังหาแผนที่เกี่ยวข้องกับ outbound tasks...');
      
      // แนวทางใหม่: หาจากการจับคู่ข้อมูล
      const planOutboundMapping = await client.query(`
        SELECT DISTINCT
          pp.id, pp.plan_id, pp.vegetable_type, pp.status, pp.completed_by,
          tm.tray_id, tm.floor, tm.slot, tm.username, tm.completed_at
        FROM planting_plans pp,
             task_monitor tm
        WHERE pp.status = 'completed'
          AND tm.action_type = 'outbound'
          AND tm.status = 'success'
        ORDER BY pp.id, tm.completed_at DESC
        LIMIT 10
      `);
      
      console.log(`📋 พบความเกี่ยวข้อง: ${planOutboundMapping.rows.length} รายการ`);
      planOutboundMapping.rows.forEach(row => {
        console.log(`- Plan ${row.plan_id} (${row.vegetable_type}): Tray ${row.tray_id} นำออกจากชั้น ${row.floor}, ช่อง ${row.slot} โดย ${row.username}`);
      });
    }
    
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    client.release();
    await pool.end();
  }
}

findRealOutboundData();