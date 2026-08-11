import { Router } from "express";
import { db } from "../db.js";

export const medicationsRouter = Router();

medicationsRouter.get("/", async (req, res) => {
  const { q } = req.query;
  if (!q || q.trim().length < 2) return res.json([]);
  const like = `%${q}%`;
  const rows = await db
    .prepare(
      `SELECT id, generic_name, commercial_names, presentation FROM medications_catalog
       WHERE generic_name ILIKE ? OR commercial_names ILIKE ?
       ORDER BY generic_name LIMIT 10`
    )
    .all(like, like);
  res.json(rows);
});
