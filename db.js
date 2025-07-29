require('dotenv').config();
const { Pool } = require('pg'); // ✅ ต้องมีบรรทัดนี้

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,
  // ✅ Connection pool settings for better performance
  max: 20, // maximum number of clients in the pool
  idleTimeoutMillis: 30000, // close idle clients after 30 seconds
  connectionTimeoutMillis: 2000, // return an error after 2 seconds if connection could not be established
});

// ✅ Handle pool errors
pool.on('error', (err) => {
  console.error('❌ Database pool error:', err);
  process.exit(-1);
});

// ✅ Graceful shutdown
process.on('SIGINT', () => {
  console.log('🔄 Closing database pool...');
  pool.end(() => {
    console.log('✅ Database pool closed.');
    process.exit(0);
  });
});

module.exports = pool;
