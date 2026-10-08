import { Router } from "express";
import { createDriverCollection, createDriverMovement, getDriverStatement } from "../controllers/driverStatements.controller";
const router = Router();
router.get("/", getDriverStatement);
router.post("/collections", createDriverCollection);
router.post("/movements", createDriverMovement);
export default router;
