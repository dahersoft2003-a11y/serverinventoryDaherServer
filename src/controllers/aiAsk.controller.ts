import { Request, Response } from "express";
import { get, push, ref, set, update } from "firebase/database";
import { database } from "../firebaseConfig";
type DataRecord = Record<string, any>;
interface BusinessData {
  products: DataRecord[];
  sells: DataRecord[];
  purchases: DataRecord[];
  customers: DataRecord[];
  suppliers: DataRecord[];
  payments: DataRecord[];
  returns: DataRecord[];
  accounts: DataRecord[];
  warehouses: DataRecord[];
}
const MAX_CONTEXT_ITEMS = 200;
const MAX_CONTEXT_CHARS = 60000;
const APP_TIME_ZONE = "Asia/Damascus";
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const DEFAULT_OPENAI_MODEL = "gpt-5.5";
const CHATGPT_ANALYST_INSTRUCTIONS = [
  "أنت ChatGPT وتعمل كمحلل بيانات لنظام مخزون ومبيعات ومحاسبة.",
  "أجب باللغة العربية وبأسلوب مباشر ومفهوم لصاحب العمل.",
  "اعتمد فقط على بيانات JSON المرسلة لك، ولا تخترع أرقاماً أو أسماء غير موجودة.",
  "إذا كانت البيانات غير كافية للإجابة بدقة، قل ذلك بوضوح واقترح ما يجب توفره.",
  "عند ذكر الأرقام المالية، وضح أنها حسب العملة المسجلة أو العملة الأساسية إذا لم تظهر العملة.",
  "اجعل الإجابة مختصرة ومنظمة، واستخدم أسطراً منفصلة عند عرض القوائم أو الملخصات.",
].join("\n");
const isPlainObject = (value: unknown): value is Record<string, any> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};
const isDataRecord = (value: DataRecord | null): value is DataRecord => value !== null;
const toNumber = (value: unknown): number => {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : 0;
};
const readNumber = (record: DataRecord, keys: string[]): number => {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null && record[key] !== "") {
      return toNumber(record[key]);
    }
  }
  return 0;
};
const readText = (record: DataRecord, keys: string[], fallback = ""): string => {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null && String(value).trim()) {
      return String(value).trim();
    }
  }
  return fallback;
};
const compactText = (value: unknown, maxLength = 180): string => {
  const text = String(value || "").trim();
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}...`;
};
const normalizeArabicDigits = (value: string): string =>
  value
    .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
    .replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)));
const normalizeQuestionText = (value: string): string =>
  normalizeArabicDigits(value)
    .toLowerCase()
    .replace(/[إأآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[^؀-ۿa-z0-9\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
const parseNumericDateText = (value: string): Date | null => {
  const dateMatch = value.match(/^(\d{1,4})[/-](\d{1,2})[/-](\d{1,4})/);
  if (!dateMatch) {
    return null;
  }
  const first = Number(dateMatch[1]);
  const second = Number(dateMatch[2]);
  const third = Number(dateMatch[3]);
  if (dateMatch[1].length === 4) {
    const isoDate = new Date(first, second - 1, third);
    return Number.isNaN(isoDate.getTime()) ? null : isoDate;
  }
  const year = third;
  const month = first > 12 ? second : first;
  const day = first > 12 ? first : second > 12 ? second : second;
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  const parsedDate = new Date(year, month - 1, day);
  return Number.isNaN(parsedDate.getTime()) ? null : parsedDate;
};
const parseStoredDate = (value: unknown): Date | null => {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }
  if (typeof value === "number") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (!value || typeof value !== "string") {
    return null;
  }
  const normalized = normalizeArabicDigits(value)
    .replace(/‏/g, "")
    .replace(/،/g, ",")
    .trim();
  const date = new Date(normalized);
  if (!Number.isNaN(date.getTime())) {
    return date;
  }
  return parseNumericDateText(normalized);
};
const monthKey = (date: Date): string =>
  date
    .toLocaleDateString("en-CA", {
      timeZone: APP_TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
    .slice(0, 7);
const isCurrentMonthDate = (value: unknown): boolean => {
  const date = parseStoredDate(value);
  return Boolean(date && monthKey(date) === monthKey(new Date()));
};
const currentMonthLabel = (): string =>
  new Date().toLocaleDateString("ar-SY", {
    timeZone: APP_TIME_ZONE,
    year: "numeric",
    month: "long",
  });
const normalizeRecord = (
  value: unknown,
  fallbackId?: string | number,
): DataRecord | null => {
  if (!isPlainObject(value)) {
    return null;
  }
  return {
    ...(fallbackId !== undefined ? { id: String(fallbackId) } : {}),
    ...value,
  };
};
const collectionValues = (value: unknown): DataRecord[] => {
  if (Array.isArray(value)) {
    return value
      .map((item, index) => normalizeRecord(item, index))
      .filter(isDataRecord);
  }
  if (!isPlainObject(value)) {
    return [];
  }
  return Object.entries(value)
    .map(([id, item]) => normalizeRecord(item, id))
    .filter(isDataRecord);
};
const extractProducts = (value: unknown): DataRecord[] => {
  if (Array.isArray(value)) {
    return collectionValues(value);
  }
  if (!isPlainObject(value)) {
    return [];
  }
  const products: DataRecord[] = [];
  Object.entries(value).forEach(([warehouseName, warehouseProducts]) => {
    if (Array.isArray(warehouseProducts)) {
      warehouseProducts.forEach((product, index) => {
        const normalizedProduct = normalizeRecord(product, index);
        if (normalizedProduct) {
          products.push({
            warehouse: normalizedProduct.warehouse || warehouseName,
            ...normalizedProduct,
          });
        }
      });
      return;
    }
    if (!isPlainObject(warehouseProducts)) {
      return;
    }
    const looksLikeProduct =
      "quantity" in warehouseProducts ||
      "code" in warehouseProducts ||
      "sellPrice" in warehouseProducts ||
      "payPrice" in warehouseProducts;
    if (looksLikeProduct) {
      products.push({
        id: warehouseProducts.id || warehouseName,
        warehouse: warehouseProducts.warehouse || "",
        ...warehouseProducts,
      });
      return;
    }
    Object.entries(warehouseProducts).forEach(([productId, product]) => {
      const normalizedProduct = normalizeRecord(product, productId);
      if (normalizedProduct) {
        products.push({
          warehouse: normalizedProduct.warehouse || warehouseName,
          ...normalizedProduct,
        });
      }
    });
  });
  return products;
};
const buildBusinessData = (rawData: Record<string, unknown>): BusinessData => ({
  products: extractProducts(rawData.products),
  sells: collectionValues(rawData.sells),
  purchases: collectionValues(rawData.purchases),
  customers: collectionValues(rawData.customer || rawData.customers),
  suppliers: collectionValues(rawData.supplier || rawData.suppliers),
  payments: collectionValues(rawData.payment || rawData.payments),
  returns: collectionValues(rawData.returns),
  accounts: collectionValues(rawData.accounts),
  warehouses: collectionValues(rawData.warehouses),
});
const recordName = (record: DataRecord, fallback: string): string =>
  readText(record, ["name", "title", "customerName", "supplierName"], fallback);
const saleAmount = (sale: DataRecord): number =>
  readNumber(sale, ["amount", "totalPrice"]);
const paymentAmount = (payment: DataRecord): number =>
  Math.abs(readNumber(payment, ["amount"]));
const sellGrossProfit = (sale: DataRecord): number => {
  const products = Array.isArray(sale.products) ? sale.products : [];
  return products.reduce((sum: number, item: unknown) => {
    if (!isPlainObject(item)) {
      return sum;
    }
    const quantity = readNumber(item, ["qty", "quantity"]);
    const sellPrice = readNumber(item, ["sellPrice", "price"]);
    const payPrice = readNumber(item, ["payPrice", "costPrice"]);
    return sum + (sellPrice - payPrice) * quantity;
  }, 0);
};
const limitItems = <T>(items: T[], limit: number): T[] => items.slice(0, limit);
const simplifyProduct = (product: DataRecord): DataRecord => ({
  id: readText(product, ["id"], ""),
  name: readText(product, ["name", "productName"], ""),
  code: readText(product, ["code"], ""),
  category: readText(product, ["category"], ""),
  warehouse: readText(product, ["warehouse"], ""),
  quantity: readNumber(product, ["quantity", "qty"]),
  payPrice: readNumber(product, ["payPrice", "costPrice"]),
  sellPrice: readNumber(product, ["sellPrice", "price"]),
  unit: readText(product, ["unit"], ""),
});
const simplifySaleProduct = (product: DataRecord): DataRecord => ({
  id: readText(product, ["id"], ""),
  name: readText(product, ["name"], ""),
  code: readText(product, ["code"], ""),
  warehouse: readText(product, ["warehouse"], ""),
  quantity: readNumber(product, ["qty", "quantity"]),
  payPrice: readNumber(product, ["payPrice", "costPrice"]),
  sellPrice: readNumber(product, ["sellPrice", "price"]),
});
const simplifySell = (sell: DataRecord): DataRecord => ({
  id: readText(sell, ["id"], ""),
  customerId: readText(sell, ["customerId"], ""),
  date: readText(sell, ["date"], ""),
  totalPrice: readNumber(sell, ["totalPrice"]),
  amount: readNumber(sell, ["amount"]),
  remainingDebt: readNumber(sell, ["remainingDebt"]),
  paymentStatus: readText(sell, ["paymentStatus"], ""),
  currency: readText(sell, ["currency"], ""),
  products: Array.isArray(sell.products)
    ? limitItems(sell.products.filter(isPlainObject).map(simplifySaleProduct), 30)
    : [],
});
const simplifyPurchase = (purchase: DataRecord): DataRecord => ({
  id: readText(purchase, ["id"], ""),
  supplierId: readText(purchase, ["supplierId"], ""),
  name: readText(purchase, ["name"], ""),
  code: readText(purchase, ["code"], ""),
  warehouse: readText(purchase, ["warehouse"], ""),
  date: readText(purchase, ["date"], ""),
  quantity: readNumber(purchase, ["quantity", "qty"]),
  payPrice: readNumber(purchase, ["payPrice"]),
  totalPrice: readNumber(purchase, ["totalPrice"]),
  amount: readNumber(purchase, ["amount"]),
  remainingDebt: readNumber(purchase, ["remainingDebt"]),
  paymentStatus: readText(purchase, ["paymentStatus"], ""),
  currency: readText(purchase, ["currency"], ""),
});
const simplifyParty = (record: DataRecord): DataRecord => ({
  id: readText(record, ["id"], ""),
  name: recordName(record, "بدون اسم"),
  number: readText(record, ["number", "phone"], ""),
  balance: readNumber(record, ["balance"]),
});
const simplifyPayment = (payment: DataRecord): DataRecord => ({
  id: readText(payment, ["id"], ""),
  type: readText(payment, ["type"], ""),
  customerId: readText(payment, ["customerId"], ""),
  supplierId: readText(payment, ["supplierId"], ""),
  date: readText(payment, ["date"], ""),
  amount: readNumber(payment, ["amount"]),
  currency: readText(payment, ["currency"], ""),
  note: compactText(payment.note),
});
const simplifyReturn = (returnRecord: DataRecord): DataRecord => ({
  id: readText(returnRecord, ["id"], ""),
  type: readText(returnRecord, ["type"], ""),
  date: readText(returnRecord, ["date", "createdAt"], ""),
  productName: readText(returnRecord, ["productName", "name"], ""),
  code: readText(returnRecord, ["code"], ""),
  warehouse: readText(returnRecord, ["warehouse"], ""),
  quantity: readNumber(returnRecord, ["quantity", "qty"]),
  returnValue: readNumber(returnRecord, ["returnValue", "totalPrice", "amount"]),
  customerId: readText(returnRecord, ["customerId"], ""),
  supplierId: readText(returnRecord, ["supplierId"], ""),
});
const simplifyWarehouse = (warehouse: DataRecord): DataRecord => ({
  id: readText(warehouse, ["id"], ""),
  name: readText(warehouse, ["name"], ""),
  location: readText(warehouse, ["location"], ""),
  isActive: Boolean(warehouse.isActive),
});
const isExpensePayment = (payment: DataRecord): boolean => {
  const type = normalizeQuestionText(String(payment.type || ""));
  return type.includes("expense") || type.includes("مصروف") || type.includes("مصاريف");
};
const buildFinancialSnapshot = (data: BusinessData) => {
  const currentMonthSells = data.sells.filter((sale) => isCurrentMonthDate(sale.date));
  const currentMonthPayments = data.payments.filter((payment) =>
    isCurrentMonthDate(payment.date),
  );
  const stockCostValue = data.products.reduce(
    (sum, product) =>
      sum +
      readNumber(product, ["quantity", "qty"]) *
        readNumber(product, ["payPrice", "costPrice"]),
    0,
  );
  const stockSellValue = data.products.reduce(
    (sum, product) =>
      sum +
      readNumber(product, ["quantity", "qty"]) *
        readNumber(product, ["sellPrice", "price"]),
    0,
  );
  const allSalesTotal = data.sells.reduce((sum, sale) => sum + saleAmount(sale), 0);
  const currentMonthSalesTotal = currentMonthSells.reduce(
    (sum, sale) => sum + saleAmount(sale),
    0,
  );
  const currentMonthRemainingDebt = currentMonthSells.reduce(
    (sum, sale) => sum + readNumber(sale, ["remainingDebt"]),
    0,
  );
  const currentMonthGrossProfit = currentMonthSells.reduce(
    (sum, sale) => sum + sellGrossProfit(sale),
    0,
  );
  const currentMonthExpenses = currentMonthPayments
    .filter(isExpensePayment)
    .reduce((sum, payment) => sum + paymentAmount(payment), 0);
  const customerDebt = data.customers.reduce((sum, customer) => {
    const balance = readNumber(customer, ["balance"]);
    return balance < 0 ? sum + Math.abs(balance) : sum;
  }, 0);
  const supplierDebt = data.suppliers.reduce((sum, supplier) => {
    const balance = readNumber(supplier, ["balance"]);
    return balance > 0 ? sum + balance : sum;
  }, 0);
  return {
    currentMonth: currentMonthLabel(),
    stockCostValue,
    stockSellValue,
    allSalesTotal,
    currentMonthSalesTotal,
    currentMonthInvoices: currentMonthSells.length,
    currentMonthRemainingDebt,
    currentMonthPaidApprox: currentMonthSalesTotal - currentMonthRemainingDebt,
    currentMonthGrossProfit,
    currentMonthExpenses,
    currentMonthNetProfitApprox: currentMonthGrossProfit - currentMonthExpenses,
    customerDebt,
    supplierDebt,
  };
};
const buildChatGPTContext = (
  rawData: Record<string, unknown>,
  itemLimit = MAX_CONTEXT_ITEMS,
) => {
  const data = buildBusinessData(rawData);
  return {
    generatedAt: new Date().toISOString(),
    timeZone: APP_TIME_ZONE,
    notes: [
      "تم حذف بيانات users من السياق قبل الإرسال.",
      "بعض القوائم قد تكون مختصرة إذا كان عدد السجلات كبيراً.",
      "الأرصدة السالبة للعملاء تعتبر مديونية على العملاء في هذا النظام.",
      "الأرصدة الموجبة للموردين تعتبر مديونية للموردين في هذا النظام.",
    ],
    counts: {
      products: data.products.length,
      sells: data.sells.length,
      purchases: data.purchases.length,
      customers: data.customers.length,
      suppliers: data.suppliers.length,
      payments: data.payments.length,
      returns: data.returns.length,
      warehouses: data.warehouses.length,
      accounts: data.accounts.length,
    },
    truncated: {
      products: data.products.length > itemLimit,
      sells: data.sells.length > itemLimit,
      purchases: data.purchases.length > itemLimit,
      customers: data.customers.length > itemLimit,
      suppliers: data.suppliers.length > itemLimit,
      payments: data.payments.length > itemLimit,
      returns: data.returns.length > itemLimit,
      warehouses: data.warehouses.length > itemLimit,
    },
    financialSnapshot: buildFinancialSnapshot(data),
    products: limitItems(data.products.map(simplifyProduct), itemLimit),
    sells: limitItems(data.sells.map(simplifySell), itemLimit),
    purchases: limitItems(data.purchases.map(simplifyPurchase), itemLimit),
    customers: limitItems(data.customers.map(simplifyParty), itemLimit),
    suppliers: limitItems(data.suppliers.map(simplifyParty), itemLimit),
    payments: limitItems(data.payments.map(simplifyPayment), itemLimit),
    returns: limitItems(data.returns.map(simplifyReturn), itemLimit),
    warehouses: limitItems(data.warehouses.map(simplifyWarehouse), itemLimit),
  };
};
const buildContextPayload = (rawData: Record<string, unknown>): string => {
  const limits = [MAX_CONTEXT_ITEMS, 100, 50, 20, 10];
  for (const limit of limits) {
    const payload = JSON.stringify(buildChatGPTContext(rawData, limit));
    if (payload.length <= MAX_CONTEXT_CHARS) {
      return payload;
    }
  }
  return JSON.stringify(buildChatGPTContext(rawData, 5));
};
const extractOpenAIText = (responseData: DataRecord): string => {
  if (typeof responseData.output_text === "string") {
    return responseData.output_text.trim();
  }
  const output = Array.isArray(responseData.output) ? responseData.output : [];
  const texts: string[] = [];
  output.forEach((item) => {
    if (!isPlainObject(item)) {
      return;
    }
    const content = Array.isArray(item.content) ? item.content : [];
    content.forEach((contentItem) => {
      if (!isPlainObject(contentItem)) {
        return;
      }
      if (typeof contentItem.text === "string") {
        texts.push(contentItem.text);
      }
    });
  });
  return texts.join("\n").trim();
};
const extractOpenAIErrorMessage = (body: string): string => {
  try {
    const parsed = JSON.parse(body);
    return parsed?.error?.message || body;
  } catch {
    return body;
  }
};
const askChatGPT = async (
  question: string,
  rawData: Record<string, unknown>,
): Promise<string> => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY غير موجود في ملف البيئة .env.");
  }
  const model = process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL;
  const contextPayload = buildContextPayload(rawData);
  const response = await fetch(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      instructions: CHATGPT_ANALYST_INSTRUCTIONS,
      input: [
        "السؤال:",
        question,
        "",
        "بيانات النظام بصيغة JSON:",
        contextPayload,
      ].join("\n"),
      max_output_tokens: 900,
    }),
  });
  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(
      `OpenAI API error ${response.status}: ${extractOpenAIErrorMessage(responseText)}`,
    );
  }
  const responseData = JSON.parse(responseText) as DataRecord;
  const answer = extractOpenAIText(responseData);
  if (!answer) {
    throw new Error("لم يرجع ChatGPT إجابة نصية واضحة.");
  }
  return answer;
};
export const askAI = async (req: Request, res: Response) => {
  try {
    const question =
      typeof req.body?.question === "string" ? req.body.question.trim() : "";
    if (!question) {
      return res.status(400).json({ message: "السؤال مطلوب." });
    }
    const snapshot = await get(ref(database));
    const databaseValue = snapshot.exists()
      ? (snapshot.val() as Record<string, unknown>)
      : {};
    const { users, ...safeData } = databaseValue;
    const answer = await askChatGPT(question, safeData);
    const createdAt = new Date().toISOString();
    const historyRef = push(ref(database, "ai/history"));
    const entryId = historyRef.key || null;
    const storedEntry = {
      title: question,
      rawText: answer,
      summary: answer.split("\n")[0] || answer,
      sections: [
        {
          order: 1,
          title: question,
          content: answer,
          items: answer
            .split("\n")
            .map((item) => item.trim())
            .filter(Boolean),
        },
      ],
      createdAt,
    };
    await set(historyRef, storedEntry);
    await update(ref(database, "ai"), {
      lastPrompt: question,
      lastResponse: storedEntry,
      lastResponseId: entryId,
      updatedAt: createdAt,
    });
    return res.status(200).json({
      answer,
      data: { answer },
      entryId,
      createdAt,
    });
  } catch (error: any) {
    console.error("Error answering AI question:", error);
    const isMissingOpenAIKey = String(error?.message || "").includes("OPENAI_API_KEY");
    return res.status(500).json({
      message: isMissingOpenAIKey
        ? "مفتاح OpenAI غير مضبوط. أضف OPENAI_API_KEY إلى ملف .env ثم أعد تشغيل السيرفر."
        : "حدث خطأ أثناء تجهيز إجابة ChatGPT.",
      error: error?.message,
    });
  }
};
