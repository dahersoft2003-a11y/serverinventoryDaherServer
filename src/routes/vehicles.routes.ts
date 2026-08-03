import express from "express";
import {
  createMyVehicleSale,
  createVehicle,
  getAllVehicles,
  getMyVehicleDiagnostics,
  getMyVehicleDashboard,
  loadVehicle,
  updateVehicle,
} from "../controllers/vehicles.controller";

const router = express.Router();

router.get("/", getAllVehicles);
router.post("/", createVehicle);
router.get("/me", getMyVehicleDashboard);
router.get("/me/diagnostics", getMyVehicleDiagnostics);
router.post("/me/sell", createMyVehicleSale);
router.put("/:id", updateVehicle);
router.post("/:id/load", loadVehicle);

export default router;
