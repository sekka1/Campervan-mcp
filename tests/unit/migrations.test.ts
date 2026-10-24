import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");
import { describe, expect, it } from "vitest";

describe("D1 Database Schema Migrations", () => {
  const migrationsDir = resolve(__dirname, "../../d1/migrations");

  it("fails to insert category = chassis under migration 0002 due to legacy CHECK constraint", () => {
    const db = new DatabaseSync(":memory:");
    const mig0001 = readFileSync(resolve(migrationsDir, "0001_initial_schema.sql"), "utf8");
    const mig0002 = readFileSync(resolve(migrationsDir, "0002_add_document_chunks.sql"), "utf8");

    db.exec(mig0001);
    db.exec(mig0002);

    const insertStmt = db.prepare(`
      INSERT INTO documents (
        id, title, category, manufacturer, applicable_chassis, raw_r2_path
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);

    expect(() => {
      insertStmt.run(
        "doc_test",
        "Test Manual",
        "chassis",
        "ford",
        "transit",
        "manuals/transit.pdf"
      );
    }).toThrow(/CHECK constraint failed/);
  });

  it("successfully applies all migrations 0001 through 0005 and allows universal categories", () => {
    const db = new DatabaseSync(":memory:");
    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    expect(files).toContain("0005_drop_legacy_category_check.sql");

    for (const file of files) {
      const sql = readFileSync(resolve(migrationsDir, file), "utf8");
      db.exec(sql);
    }

    const insertStmt = db.prepare(`
      INSERT INTO documents (
        id, title, category, manufacturer, applicable_chassis, raw_r2_path, model, market, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // Verify all 5 universal taxonomy categories are accepted without error
    const categories = ["chassis", "climate", "power", "plumbing", "other"];
    for (const cat of categories) {
      insertStmt.run(
        `doc_${cat}`,
        `Manual for ${cat}`,
        cat,
        "manufacturer_x",
        "universal",
        `manuals/${cat}.pdf`,
        "model_y",
        "us",
        JSON.stringify({ voltage: 12 })
      );
    }

    const rows = db.prepare("SELECT category FROM documents ORDER BY id").all() as Array<{ category: string }>;
    expect(new Set(rows.map((r) => r.category))).toEqual(new Set(categories));
  });
});
