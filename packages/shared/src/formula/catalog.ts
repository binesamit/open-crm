// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The formula column's function reference (03 §2.18): every function the engine knows, with
 * its syntax, what it does and a worked example. `formula-catalog.test.ts` checks it covers FORMULA_FUNCTIONS
 * exactly and that every example evaluates to its `result` (examples use only literals, so they run anywhere).
 */
export type FormulaCategory = 'logic' | 'math' | 'text' | 'date';

export type FormulaDoc = {
  name: string;
  category: FormulaCategory;
  syntax: string;
  /** What it does (Hebrew — the UI language). */
  he: string;
  example: string;
  /** What `example` returns (as `formatFormulaResult` shows it). */
  result: string;
};

const d = (
  name: string,
  category: FormulaCategory,
  syntax: string,
  he: string,
  example: string,
  result: string,
): FormulaDoc => ({ name, category, syntax, he, example, result });

export const FORMULA_CATALOG: FormulaDoc[] = [
  // Logic
  d(
    'IF',
    'logic',
    'IF(תנאי, אם_כן, אם_לא)',
    'מחזיר ערך אחד אם התנאי מתקיים ואחר אם לא',
    'IF(5>3,"גבוה","נמוך")',
    'גבוה',
  ),
  d('AND', 'logic', 'AND(תנאי1, תנאי2, …)', 'אמת אם כל התנאים מתקיימים', 'AND(1>0,2>1)', 'TRUE'),
  d('OR', 'logic', 'OR(תנאי1, תנאי2, …)', 'אמת אם לפחות תנאי אחד מתקיים', 'OR(1>2,2>1)', 'TRUE'),
  d('NOT', 'logic', 'NOT(תנאי)', 'הופך אמת לשקר ולהפך', 'NOT(1>2)', 'TRUE'),
  d(
    'SWITCH',
    'logic',
    'SWITCH(ערך, מקרה1, תוצאה1, …, ברירת_מחדל)',
    'בוחר תוצאה לפי הערך; האחרון (בלי זוג) = ברירת מחדל',
    'SWITCH("ב","א",1,"ב",2,0)',
    '2',
  ),
  d('IFERROR', 'logic', 'IFERROR(ערך, אם_שגיאה)', 'מחזיר ערך חלופי כשהחישוב נכשל', 'IFERROR(DIVIDE(1,0),"אין")', 'אין'),
  d('ISBLANK', 'logic', 'ISBLANK(ערך)', 'אמת אם הערך ריק', 'ISBLANK("")', 'TRUE'),
  // Math
  d('SUM', 'math', 'SUM(מספר1, מספר2, …)', 'סכום', 'SUM(10,20,5)', '35'),
  d('AVERAGE', 'math', 'AVERAGE(מספר1, מספר2, …)', 'ממוצע', 'AVERAGE(10,20,30)', '20'),
  d('MIN', 'math', 'MIN(מספר1, מספר2, …)', 'הקטן ביותר', 'MIN(4,9,2)', '2'),
  d('MAX', 'math', 'MAX(מספר1, מספר2, …)', 'הגדול ביותר', 'MAX(4,9,2)', '9'),
  d('COUNT', 'math', 'COUNT(ערך1, ערך2, …)', 'כמה ערכים לא ריקים', 'COUNT(1,"",3)', '2'),
  d('ROUND', 'math', 'ROUND(מספר, ספרות)', 'עיגול לספרות אחרי הנקודה', 'ROUND(3.14159,2)', '3.14'),
  d('ROUNDUP', 'math', 'ROUNDUP(מספר, ספרות)', 'עיגול כלפי מעלה', 'ROUNDUP(3.141,1)', '3.2'),
  d('ROUNDDOWN', 'math', 'ROUNDDOWN(מספר, ספרות)', 'עיגול כלפי מטה', 'ROUNDDOWN(3.19,1)', '3.1'),
  d('ABS', 'math', 'ABS(מספר)', 'ערך מוחלט', 'ABS(-7)', '7'),
  d('MOD', 'math', 'MOD(מספר, מחלק)', 'שארית חלוקה', 'MOD(10,3)', '1'),
  d('DIVIDE', 'math', 'DIVIDE(מונה, מכנה)', 'חילוק (שגיאה בחלוקה ב-0)', 'DIVIDE(10,4)', '2.5'),
  d('MULTIPLY', 'math', 'MULTIPLY(מספר1, מספר2, …)', 'מכפלה', 'MULTIPLY(2,3,4)', '24'),
  d('MINUS', 'math', 'MINUS(מספר1, מספר2)', 'חיסור', 'MINUS(10,4)', '6'),
  d('POWER', 'math', 'POWER(בסיס, חזקה)', 'חזקה', 'POWER(2,10)', '1024'),
  d('SQRT', 'math', 'SQRT(מספר)', 'שורש ריבועי', 'SQRT(81)', '9'),
  d('VALUE', 'math', 'VALUE(טקסט)', 'טקסט של מספר → מספר', 'VALUE("42")+1', '43'),
  // Text
  d(
    'CONCATENATE',
    'text',
    'CONCATENATE(טקסט1, טקסט2, …)',
    'חיבור טקסטים (גם עם &)',
    'CONCATENATE("שלום"," ","עולם")',
    'שלום עולם',
  ),
  d('LEN', 'text', 'LEN(טקסט)', 'אורך הטקסט', 'LEN("Bines")', '5'),
  d('LEFT', 'text', 'LEFT(טקסט, תווים)', 'התווים הראשונים', 'LEFT("Bines OS",5)', 'Bines'),
  d('RIGHT', 'text', 'RIGHT(טקסט, תווים)', 'התווים האחרונים', 'RIGHT("Bines OS",2)', 'OS'),
  d('TRIM', 'text', 'TRIM(טקסט)', 'מוריד רווחים מההתחלה ומהסוף', 'TRIM("  היי  ")', 'היי'),
  d('UPPER', 'text', 'UPPER(טקסט)', 'אותיות גדולות', 'UPPER("abc")', 'ABC'),
  d('LOWER', 'text', 'LOWER(טקסט)', 'אותיות קטנות', 'LOWER("ABC")', 'abc'),
  d(
    'REPLACE',
    'text',
    'REPLACE(טקסט, מיקום, אורך, חדש)',
    'מחליף חלק לפי מיקום',
    'REPLACE("2026-10",5,1,"/")',
    '2026/10',
  ),
  d(
    'SUBSTITUTE',
    'text',
    'SUBSTITUTE(טקסט, ישן, חדש)',
    'מחליף כל הופעה של טקסט',
    'SUBSTITUTE("a-b-c","-","/")',
    'a/b/c',
  ),
  d('SEARCH', 'text', 'SEARCH(מחפש, טקסט, [מיקום])', 'מיקום הטקסט (0 = לא נמצא)', 'SEARCH("OS","Bines OS")', '7'),
  d('REPT', 'text', 'REPT(טקסט, פעמים)', 'חוזר על טקסט', 'REPT("★",3)', '★★★'),
  d('TEXT', 'text', 'TEXT(ערך)', 'הופך ערך לטקסט', 'TEXT(12)&" יח׳"', '12 יח׳'),
  // Dates
  d('TODAY', 'date', 'TODAY()', 'התאריך של היום', 'TODAY()>DATE(2020,1,1)', 'TRUE'),
  d('NOW', 'date', 'NOW()', 'עכשיו (תאריך ושעה)', 'YEAR(NOW())>2000', 'TRUE'),
  d('DATE', 'date', 'DATE(שנה, חודש, יום)', 'בונה תאריך', 'DATE(2026,10,3)', '2026-10-03'),
  d('DAYS', 'date', 'DAYS(סיום, התחלה)', 'ימים בין שני תאריכים', 'DAYS("2026-10-10","2026-10-03")', '7'),
  d(
    'WORKDAYS',
    'date',
    'WORKDAYS(סיום, התחלה)',
    'ימי עבודה בטווח (בלי סוף השבוע, החגים והימים החופשיים של החשבון)',
    'WORKDAYS("2026-10-08","2026-10-04")',
    '5',
  ),
  d(
    'ADD_WORKDAYS',
    'date',
    'ADD_WORKDAYS(תאריך, ימים)',
    'מוסיף ימי עבודה לתאריך (מדלג על סוף השבוע, החגים והימים החופשיים)',
    'ADD_WORKDAYS("2026-10-08",1)',
    '2026-10-11',
  ),
  d(
    'HOURS_DIFF',
    'date',
    'HOURS_DIFF(סיום, התחלה)',
    'שעות בין שני זמנים',
    'HOURS_DIFF("2026-10-03T12:00:00Z","2026-10-03T09:30:00Z")',
    '2.5',
  ),
  d('ADD_DAYS', 'date', 'ADD_DAYS(תאריך, ימים)', 'מוסיף ימים לתאריך', 'ADD_DAYS("2026-10-03",10)', '2026-10-13'),
  d(
    'SUBTRACT_DAYS',
    'date',
    'SUBTRACT_DAYS(תאריך, ימים)',
    'מחסיר ימים מתאריך',
    'SUBTRACT_DAYS("2026-10-03",3)',
    '2026-09-30',
  ),
  d(
    'FORMAT_DATE',
    'date',
    'FORMAT_DATE(תאריך, תבנית)',
    'מציג תאריך בתבנית (DD, MM, YYYY)',
    'FORMAT_DATE("2026-10-03","DD/MM/YYYY")',
    '03/10/2026',
  ),
  d('YEAR', 'date', 'YEAR(תאריך)', 'השנה', 'YEAR("2026-10-03")', '2026'),
  d('MONTH', 'date', 'MONTH(תאריך)', 'החודש (1–12)', 'MONTH("2026-10-03")', '10'),
  d('DAY', 'date', 'DAY(תאריך)', 'היום בחודש', 'DAY("2026-10-03")', '3'),
  d('WEEKNUM', 'date', 'WEEKNUM(תאריך)', 'מספר השבוע בשנה', 'WEEKNUM("2026-01-08")', '2'),
  d('HOUR', 'date', 'HOUR(זמן)', 'השעה (UTC)', 'HOUR("2026-10-03T14:25:00Z")', '14'),
  d('MINUTE', 'date', 'MINUTE(זמן)', 'הדקה', 'MINUTE("2026-10-03T14:25:00Z")', '25'),
];

export const FORMULA_CATEGORIES: FormulaCategory[] = ['logic', 'math', 'text', 'date'];
