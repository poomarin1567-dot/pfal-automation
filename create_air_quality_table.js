const pool = require('./db');

async function createAirQualityTable() {
  try {
    const createTableQuery = `
      CREATE TABLE IF NOT EXISTS air_quality_logs (
        id SERIAL PRIMARY KEY,
        station_id INTEGER DEFAULT 1,
        co2_ppm INTEGER,
        temperature_celsius DECIMAL(5,2),
        humidity_percent DECIMAL(5,2),
        recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `;

    console.log('📋 Creating air_quality_logs table...');
    await pool.query(createTableQuery);
    console.log('✅ air_quality_logs table created successfully');

    // Create index for better performance
    const createIndexQuery = `
      CREATE INDEX IF NOT EXISTS idx_air_quality_station_recorded 
      ON air_quality_logs(station_id, recorded_at DESC);
    `;
    
    await pool.query(createIndexQuery);
    console.log('✅ Index created successfully');

    process.exit(0);
  } catch (error) {
    console.error('❌ Error creating air_quality_logs table:', error);
    process.exit(1);
  }
}

createAirQualityTable();