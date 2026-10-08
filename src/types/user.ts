import type { CommissionRateChange } from "./driverFinance";

export interface InventoryUser {
  id?: string;
  username: string;
  password?: string;
  role: string;
  permissions?: string[];
  vehicleId?: string;
  vehicleName?: string;
  createdAt?: string;
  updatedAt?: string;
  commissionRate?: number;
  commissionEffectiveFrom?: string;
  commissionRateHistory?: CommissionRateChange[];
}

export interface InventoryUserResponse {
  id: string;
  username: string;
  role: string;
  permissions: string[];
  vehicleId?: string;
  vehicleName?: string;
  createdAt?: string;
  updatedAt?: string;
  commissionRate?: number;
  commissionEffectiveFrom?: string;
  commissionRateHistory?: CommissionRateChange[];
}
