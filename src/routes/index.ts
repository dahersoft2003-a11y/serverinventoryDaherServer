import { Router } from "express";
import authRoutes from "./auth.routes";
import productsRouter from "./products.routes";
import suppliersRouter from "./suppliers.routes";
import purchasesRouter from "./purchases.routes";
import transactionsRouter from "./transactions.routes";
import paymentsRouter from "./payments.routes";
import customersRouter from "./customer.routes";
import sellsRouter from "./sells.routes";
import warehousesRouter from "./warehouse.routes";
import account from "./account"
import journalEntriesRouter from "./journalEntries.routes";
import aiRoutes from "./ai";
import returnsRouter from "./returns.routes";
import invoiceDraftRouter from "./invoiceDraft.routes";
import exchangeRouter from "./exchange.routes";
import doneExchangeRouter from "./doneExchange.routes";
import usersRouter from "./users.routes";
import materialReservationsRouter from "./materialReservations.routes";
import quotationsRouter from "./quotations.routes";
import vehiclesRouter from "./vehicles.routes";
import currencyMigrationRouter from "./currencyMigration.routes";


const router = Router();

router.use("/auth", authRoutes);
router.use("/users", usersRouter);

router.use("/products", productsRouter);
router.use("/suppliers", suppliersRouter);
router.use("/purchases", purchasesRouter);
router.use("/transactions", transactionsRouter);
router.use("/payments", paymentsRouter);
router.use("/customers", customersRouter);
router.use("/sells", sellsRouter);
router.use("/warehouses", warehousesRouter);
router.use('/account' , account)
router.use("/returns", returnsRouter);
router.use("/journal-entries", journalEntriesRouter);
router.use("/ai", aiRoutes);
router.use("/invoice-draft", invoiceDraftRouter);
router.use("/exchange", exchangeRouter);
router.use("/doneExchange", doneExchangeRouter);
router.use("/material-reservations", materialReservationsRouter);
router.use("/quotations", quotationsRouter);
router.use("/vehicles", vehiclesRouter);
router.use("/currency-migration", currencyMigrationRouter);


export default router;
