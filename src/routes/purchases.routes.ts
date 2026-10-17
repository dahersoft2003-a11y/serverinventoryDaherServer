
import express, { Request, Response } from 'express';
import { getAllPurchases } from '../controllers/purchases.controller';
import { handleBulkPurchase, handlePurchase } from '../functions/transactions';
const router = express.Router();

router.get('/', getAllPurchases);
router.post('/', async (req: Request, res: Response) => {
  try {
    const newPurchase = req.body?.newPurchase || req.body;
    if (!newPurchase?.requestId) return res.status(400).json({ message: "معرف طلب الشراء مطلوب" });
    const newProduct = req.body?.newProduct;
    const data = Array.isArray(newPurchase?.products)
      ? await handleBulkPurchase({ newPurchase })
      : newProduct ? await handlePurchase({ newPurchase, newProduct }) : null;
    if (!data) return res.status(400).json({ message: "بيانات منتجات الشراء غير مكتملة" });
    return res.json({ message: "تمت عملية الشراء", data });
  } catch (error: any) {
    return res.status(400).json({ message: error.message });
  }
});

export default router;
