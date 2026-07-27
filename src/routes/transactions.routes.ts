import express, { Request, Response } from "express";
import { customerPayment, handleBulkPurchase, handleCustomerReturnSafe, handlePurchase, handleSell, handleSupplierReturn, supplierPayment, warehouseTransfer } from "../functions/transactions";
import { addAfterSellDiscountInternal } from "../controllers/sells.controller";
import { updateCustomerBalanceInternal } from "../controllers/customer.controller";
import { endExchange } from "../controllers/exchange.controller";

const router = express.Router();

router.post("/purchase", async (req: Request, res: Response) => {
  console.log(req.body)
  try {
    const { newPurchase, newProduct } = req.body;

    if (!newPurchase || !newProduct) {
      throw new Error("❌ بيانات الشراء أو المنتج غير مكتملة");
    }
    const result = await handlePurchase({newPurchase, newProduct});
    res.json({ message: "✅ تمت عملية الشراء", data: result });
  } catch (error: any) {
    res.status(400).json({ message: error.message });
  }
});

router.post("/purchase-invoice", async (req: Request, res: Response) => {
  try {
    const { newPurchase } = req.body;

    if (!newPurchase) {
      throw new Error("Purchase invoice data is missing");
    }

    const result = await handleBulkPurchase({ newPurchase });
    res.json({ message: "Purchase invoice completed", data: result });
  } catch (error: any) {
    res.status(400).json({ message: error.message });
  }
});

router.post("/sell", async (req: Request, res: Response) => {
  try {
    const { newSell } = req.body;
    if (!newSell) {
      throw new Error("❌ بيانات البيع غير مكتملة");
    }
    const result = await handleSell({newSell});
    res.json({ message: "✅ تمت عملية البيع", data: result });
  } catch (error: any) {
    res.status(400).json({ message: error.message });
  }
});

router.post("/endExchange", endExchange);

router.post("/customerPayment", async (req: Request, res: Response) => {
  try {
    const { paymentData } = req.body;
    if (!paymentData) {
      throw new Error("❌ بيانات الدفع غير مكتملة");
    }
    const result = await customerPayment(paymentData);
    res.json({ message: "✅ تمت عملية الدفع", data: result });
  } catch (error: any) {
    res.status(400).json({ message: error.message });
  }
});

router.post("/supplierPayment", async (req: Request, res: Response) => {
  try {
    const { paymentData } = req.body;
    if (!paymentData) {
      throw new Error("❌ بيانات الدفع غير مكتملة");
    }
    const result = await supplierPayment(paymentData);
    res.json({ message: "✅ تمت عملية الدفع", data: result });
  } catch (error: any) {
    res.status(400).json({ message: error.message });
  }
});

router.post("/SupplierReturn", async (req: Request, res: Response) => {
  try {
    const { newReturn } = req.body;
    if (!newReturn) {
      throw new Error("❌ بيانات الدفع غير مكتملة");
    }
    const result = await handleSupplierReturn(newReturn);
    res.json({ message: "✅ تمت عملية الدفع", data: result });
  } catch (error: any) {
    res.status(400).json({ message: error.message });
  }
});

router.post("/CustomerReturn", async (req: Request, res: Response) => {
  try {
    const { newReturn } = req.body;
    if (!newReturn) {
      throw new Error("❌ بيانات الدفع غير مكتملة");
    }
    const result = await handleCustomerReturnSafe(newReturn);
    res.json({ message: "✅ تمت عملية الدفع", data: result });
  } catch (error: any) {
    res.status(400).json({ message: error.message });
  }
});

router.post("/warehouseTransfer", async (req: Request, res: Response) => {
  try {
    const { transferData } = req.body;
    if (!transferData) {
      throw new Error("❌ بيانات الدفع غير مكتملة");
    }
    const result = await warehouseTransfer(transferData);
    res.json({ message: "✅ تمت عملية النقل بين المستودعات", data: result });
  } catch (error: any) {
    res.status(400).json({ message: error.message });
  }
});

router.post("/afterSellDiscount", async (req: Request, res: Response) => {
  try {
    const { discount, sellId, customerId } = req.body;

    if (!discount || !sellId || !customerId) {
      throw new Error("❌ بيانات الخصم أو معرف الفاتورة أو معرف العميل غير مكتملة");
    }

    await addAfterSellDiscountInternal({sellId, discount});

    await updateCustomerBalanceInternal(
      customerId,
      discount
    )

    res.json({ message: "✅ تمت عملية الخصم بعد البيع" });
  } catch (error: any) {
    res.status(400).json({ message: error.message });
  }
});


export default router;
