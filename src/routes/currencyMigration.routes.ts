import express from "express";
import {
  previewCurrencyMigration,
  runCurrencyMigration,
} from "../controllers/currencyMigration.controller";

const router = express.Router();

router.get("/preview", previewCurrencyMigration);
router.post("/run", runCurrencyMigration);

export default router;
