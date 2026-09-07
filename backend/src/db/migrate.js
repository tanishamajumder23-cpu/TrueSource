#!/usr/bin/env node
/**
 * Migration runner: `npm run db:migrate`.
 *
 * Applies schema.sql, which is written entirely with IF NOT EXISTS so it is
 * idempotent -- running it twice is a no-op, which keeps setup foolproof for
 * anyone cloning the repo.
 *
 * Also creates the database itself if it does not exist yet, by connecting to
 * the default `postgres` database first. That removes the single most common
 * setup failure ("database veristate does not exist").
 */

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const config = require('../config/env');

const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

function baseConnection(databaseName) {
  if (config.database.url) {
    // Swap the database name in the connection string.
    const url = new URL(config.database.url);
    url.pathname = `/${databaseName}`;
    return { connectionString: url.toString(), ssl: config.database.ssl ? { rejectUnauthorized: false } : undefined };
  }
  return {
    host: config.database.host,
    port: config.database.port,
    user: config.database.user,
    password: config.database.password,
    database: databaseName,
    ssl: config.database.ssl ? { rejectUnauthorized: false } : undefined,
  };
}

function targetDatabaseName() {
  if (config.database.url) {
    try {
      return new URL(config.database.url).pathname.replace(/^\//, '') || config.database.name;
    } catch {
      return config.database.name;
    }
  }
  return config.database.name;
}

async function ensureDatabaseExists(dbName) {
  const admin = new Client(baseConnection('postgres'));
  await admin.connect();
  try {
    const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (rows.length === 0) {
      // Identifiers cannot be parameterised, so quote it defensively instead.
      await admin.query(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`);
      console.log(`Created database "${dbName}".`);
    } else {
      console.log(`Database "${dbName}" already exists.`);
    }
  } finally {
    await admin.end();
  }
}

async function applySchema(dbName) {
  const client = new Client(baseConnection(dbName));
  await client.connect();
  try {
    const sql = fs.readFileSync(SCHEMA_PATH, 'utf8');
    await client.query(sql);
    console.log('Schema applied: analyses, claims, verdicts, sources (+ indexes).');
  } finally {
    await client.end();
  }
}

async function main() {
  const dbName = targetDatabaseName();
  console.log(`Running Veristate migrations against "${dbName}"...`);

  try {
    await ensureDatabaseExists(dbName);
  } catch (error) {
    // Some managed providers forbid CREATE DATABASE. That is fine as long as the
    // target database already exists, so we warn and press on to the schema step.
    console.warn(`Could not verify/create the database (${error.message}). Attempting to apply the schema anyway...`);
  }

  try {
    await applySchema(dbName);
    console.log('\nMigrations complete. Start the server with: npm run dev');
  } catch (error) {
    console.error('\nMigration failed:', error.message);
    console.error(
      '\nCheck that PostgreSQL is running and that your .env credentials are correct\n' +
        '(DATABASE_URL, or PGHOST / PGPORT / PGUSER / PGPASSWORD / PGDATABASE).\n' +
        'Veristate still runs without a database - you just will not get history.',
    );
    process.exitCode = 1;
  }
}

main();
