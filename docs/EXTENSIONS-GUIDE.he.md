# בניית תוסף ל-Bines OS — מדריך למפתחים

סקירה קצרה למפתחים שרוצים לבנות תוסף: מה זה תוסף, המניפסט, ה-SDK של הדף, שרת משלכם (לא חובה) ואיך מפרסמים.

> **המדריך המלא והעדכני למפתחים נמצא ב-[`docs/extensions/README.md`](extensions/README.md)** (באנגלית: כל המקומות
> שתוסף מופיע בהם, כל ה-API של ה-SDK, בלוקי אוטומציה, מגבלות, ביקורת הקטלוג), עם מדריך צעד-אחר-צעד ב-
> [`docs/extensions/QUICKSTART.md`](extensions/QUICKSTART.md). בכל התקנה של המערכת הם מוצגים גם בכתובת
> `/api/docs/extensions` (ובקישור "מדריך למפתחים" בניהול → תוספות → למפתחים).

באנגלית: [`EXTENSIONS-GUIDE.md`](EXTENSIONS-GUIDE.md). ההחלטות: `docs/DECISIONS.md` D27.

תוסף מוסיף יכולת ל-Bines OS **בלי לשנות את הליבה**: תצוגת לוח, נתונים (תבניות, מתכוני אוטומציה, תבניות סוכנים),
ולפי הצורך — שרת משלו שהמערכת מדברת איתו. הקוד מתארח אצלך; Bines טוען את הדף שלך ב-iframe מבודד ושולח אליך קריאות
חתומות. הקוד שלך אף פעם לא רץ בתוך Bines.

המטרה: תצוגת לוח עובדת בתוך שעה.

---

## 1. התחלה מהירה (10 דקות)

```sh
# מתוך עותק של הריפו של Bines
node packages/create-bines-app/index.mjs my-view --name "התצוגה שלי"     # תצוגת לוח
node packages/create-bines-app/index.mjs crm-sync --server               # + שרת משלו (סעיף 6)
cd my-view
npm install
npm run dev                                                              # http://localhost:5180
```

ב-Bines של **סביבת פיתוח** (`pnpm dev`, ‏http://localhost:5173), כמנהל חשבון:

1. **ניהול ← תוספות ← הוספה לפי כתובת** ← `http://localhost:5180/manifest.json` ← **בדיקה**.
2. מסך ההסכמה מראה מה התוסף מוסיף ואילו הרשאות הוא מבקש, במילים פשוטות. תופיע אזהרת **מצב פיתוח**: כתובות
   `localhost` מתקבלות רק מחוץ לפרודקשן.
3. אישור. פותחים לוח ← **+ תצוגה** ← התצוגה שלך. היא קוראת את פריטי הלוח דרך ה-SDK.

עורכים את `src/main.ts`; Vite טוען את המסגרת מחדש.

---

## 2. קובץ התיאור (manifest)

`manifest.config.mjs` בונה אותו (שרת הפיתוח מגיש אותו ב-`/manifest.json`; `node manifest.config.mjs
https://ext.example.com` מדפיס את גרסת הפרודקשן). הסכמה: `packages/shared/src/extensions/manifest.ts`.

| שדה | כללים |
|---|---|
| `id` | `a-z0-9-`, ‏2–48 תווים, לא משתנה לעולם — המפתח של התוסף בכל חשבון |
| `version` | semver. גרסה שלא מבקשת **שום דבר חדש** מתעדכנת לבד (בדיקה יומית); **הרשאה**, **מקור** או **יכולת** חדשים (או הוספת `server`) מחכים לאישור מנהל |
| `permissions` | ההרשאות של טוקני ה-API חוץ מ-`admin` (`boards:read`, `items:write`, `updates:write` …). לבקש את המינימום |
| `origins` | מקורות `https://` שמהם הקוד שלך נטען / שבהם השרת שלך מאזין (בלי נתיב). אף פעם לא המקור של המערכת עצמה. `http://localhost:*` רק בפיתוח |
| `features[].url` | חייב להיות על אחד מה-`origins` |
| `server.lifecycle_url` | רשות (סעיף 6); חייב להיות על אחד מה-`origins` |
| `data` | חבילת נתונים: `board_templates`, `starter_kit`, `automation_recipes`, `agent_templates` (בלי קוד בכלל) |

---

## 3. הדף: ‎`@bines/ext-sdk`

הדף רץ ב-`<iframe sandbox>` על המקור **שלך**, ולא רואה את ההתחברות של המשתמש. המערכת מעבירה לו **טוקן ל-10
דקות** ב-`postMessage` (אף פעם לא בכתובת); ה-SDK שומר אותו בזיכרון ומבקש חדש לפני שהוא פג.

```ts
import { createBinesSdk } from '@bines/ext-sdk';

const bines = createBinesSdk({ hostOrigin: 'https://your-bines.example.com' }); // לנעול בפרודקשן
const ctx = await bines.ready();
const { data } = await bines.items();
await bines.execute('openItemCard', { itemId: id });
// בונה האוטומציות של המערכת מעל הדף, עם טריגר של התוסף עצמו (רק בלחיצה של המשתמש):
const { saved, automation_id } = await bines.openAutomationBuilder({
  trigger: 'conversation_button',
  // ה-`inputs` של הטריגר (במניפסט): האוטומציה רצה רק כשב-payload של ההפעלה button === 'b-7'.
  config: { with_item: true, inputs: { button: 'b-7' } },
});
const live = await bines.automations('button'); // אילו אוטומציות משתמשות בטריגר שלו
await bines.setAutomationActive(live[0].id, false); // הפעלה / כיבוי, בהרשאות של המשתמש
```

`openAutomationBuilder` פותח את בונה האוטומציות של המערכת בחלון מעל הדף, והטריגר כבר בחור — רק מפתח של
`automation_trigger` של התוסף עצמו, על לוח שהטוקן שלו קורא. ההרשאות של המשתמש קובעות (מי שלא רשאי לנהל אוטומציות בלוח
מקבל את הסירוב הרגיל), אחד בכל פעם ולא מתוך מודאל; מחזיר `{ saved, automation_id? }` כשהחלון נסגר.

**שדות של טריגר (טריגר אחד, הרבה אוטומציות).** `automation_trigger` יכול להגדיר `inputs` (עד 10, טקסט:
`{ key, label, label_en?, placeholder? }`). כל אוטומציה שומרת ערכים משלה ב-`trigger.inputs` (למשל `{ button: 'b-7' }`) —
בבונה הם שדות, ו-`openAutomationBuilder({ config: { inputs } })` ממלא ונועל אותם. הפעלה (`fire`) מריצה רק אוטומציות שהערכים
שלהן שווים לאותם מפתחות ב-`payload`; אוטומציה בלי ערכים רצה על כל הפעלה, כמו קודם.
`automations(trigger)` (`GET /ext/automations?trigger=`) מחזיר את האוטומציות שמשתמשות בטריגר שלו, על הלוחות שהטוקן קורא
והמשתמש רואה (קריאה בלבד). `setAutomationActive(id, active)` מפעיל / מכבה אוטומציה כזו — דרך המערכת, בסשן ובהרשאות של
המשתמש (בלי `automation.manage` בלוח — הסירוב הרגיל), רק על טריגר של התוסף עצמו ועל לוח שהטוקן קורא. עריכה נשארת במערכת.

מה שטוקן רשאי = **חיתוך** של: ההרשאות של המשתמש × ההרשאות שהמנהל אישר × הלוח שהתצוגה עליו × רשימת נתיבים מותרת
(תוכן לוחות בלבד — אף פעם לא טוקנים, תוספות, ניהול, AI, סוכנים או קונסולת הבעלים). כל כתיבה נרשמת "דרך תוסף X"
וניתנת לביטול.

כללים: להציג נתונים מה-API **כטקסט** (`textContent`), לעולם לא כ-HTML; טוקנים רק בזיכרון; לא לכתוב אותם ללוג.

---

## 4. הרשאות, הסכמה ואורחים

- רק **מנהלי** החשבון מתקינים; חברים יכולים לבקש. המנהל יכול לאשר פחות ממה שביקשת (לטפל ב-`403 insufficient_scope`
  בעדינות), להגביל ללוחות מסוימים, ולהחליט אם אורחים רשאים (כבוי כברירת מחדל).
- השבתה, הסרה, צמצום הרשאות או **השבתת החירום** של הפלטפורמה חלים כבר בבקשה הבאה.

---

## 5. גרסאות ועדכונים

- Bines מושך את ה-manifest **פעם ביום** (ובלחיצה על "בדיקת עדכונים").
- אותה גרסה או ישנה יותר ← כלום. חדשה בלי שום דבר חדש ← מתעדכנת, נרשמת בהיסטוריית הגרסאות, והשרת שלך מקבל
  `updated`. חדשה **עם** הרשאה / מקור / יכולת חדשים ← נשארת בגרסה הקודמת; המנהלים מקבלים התראה בפעמון ומאשרים
  במסך ההסכמה.
- המנהל יכול לכבות עדכון אוטומטי, **לנעול** גרסה, ו**לחזור** לכל גרסה שאושרה (והיא ננעלת).

---

## 6. שרת משלך (רשות)

מוסיפים `"server": { "lifecycle_url": "…" }`. בהתקנה התוסף מקבל **משתמש תוסף** (חבר בחשבון, לא אדם) ו**פרטי לקוח
OAuth**.

### קריאות מחזור חיים

`POST <lifecycle_url>` עם JSON והכותרות:

```
x-bines-event:      extension.installed | extension.updated | extension.enabled | extension.disabled | extension.uninstalled
x-bines-timestamp:  <מילישניות>
x-bines-signature:  sha256=<hex של HMAC-SHA256(signing_secret, "<timestamp>.<הגוף כפי שהוא>")>
```

- `installed` מביא את פרטי הגישה (`client_id`, `client_secret`, `signing_secret`, `token_endpoint`, `api_base`)
  וחתום בסוד שהוא מביא. **להוכיח** אותם — להחליף אותם בטוקן (למטה) — לפני שסומכים עליהם: רק המערכת האמיתית יכולה
  להנפיק אותו. לשמור אותם באחסון סודות, לכל התקנה.
- כל קריאה אחרת חתומה בסוד השמור. לבדוק את החתימה על הגוף **הגולמי**, ולסרב לחותמת זמן ישנה מ-5 דקות (replay).
- `disabled` / `enabled` עם `"reason": "platform_kill"` = השבתת החירום של בעל הפלטפורמה.
- אחרי `uninstalled` פרטי הגישה וכל הטוקנים מתים; למחוק את מה ששמרת.
- לענות `2xx` מהר. קריאה שנכשלה מוצגת למנהל, שיכול ללחוץ **חיבור מחדש** (פרטים חדשים + `installed` חדש).

### טוקנים: OAuth ‏`client_credentials`

```sh
curl -u "$CLIENT_ID:$CLIENT_SECRET" -d grant_type=client_credentials https://your-bines.example.com/oauth/token
curl -H "Authorization: Bearer bos_xat_…" https://your-bines.example.com/api/v1/boards/<board>/items
```

הטוקן פועל כמשתמש התוסף × ההרשאות שאושרו × הלוחות שאושרו × אותה רשימת נתיבים. `scope=` יכול לצמצם, לא להרחיב.
הוא חי שעה; מבקשים חדש עם פרטי הגישה.

### עזרים

```ts
import { createServerClient, verifyLifecycle } from '@bines/ext-sdk/server';
```

`create-bines-app --server` כותב דוגמה ב-Node בלי תלויות (`server/lifecycle.mjs`).

---

## 7. העלאה לאוויר

1. `npm run build` ← לארח את `dist/` ואת ה-manifest על מקור **https** שלך (TLS 1.2+, ‏HSTS).
2. לנעול `hostOrigin` ב-SDK ולהגדיר `Content-Security-Policy: frame-ancestors <הכתובת של Bines>`.
3. כל חשבון מוסיף אותך לפי כתובת — או ש**בעל הפלטפורמה** מפרסם אותך בקטלוג לכל החשבונות.

### בדיקת האבטחה לקטלוג

בעל הפלטפורמה מסמן כל סעיף לפני שתוסף עם קוד נכנס לקטלוג: HTTPS בלבד + HSTS; רק ההרשאות הנחוצות, עם הסבר;
טוקנים רק בזיכרון ולא בלוג, סודות בשדות `secret`; בדיקת חתימת HMAC + חותמת זמן בכל קריאה; אין `eval` של תוכן
משתמשים; מדיניות פרטיות; ובצד הפלטפורמה — קצב לכל התקנה, מכסה, זמן קצוב, השבתת חירום ויומן.

---

## 8. תקלות נפוצות

| מה רואים | למה |
|---|---|
| `422 manifest_invalid` עם `must be https` | שרת פרודקשן מסרב למקורות `http://` ו-`localhost` |
| `feature_origin_not_listed` / `server_origin_not_listed` | המקור של הכתובת חסר ב-`origins` |
| המסגרת ריקה | ה-`frame-ancestors` של הדף שלך לא כולל את Bines, או שהכתובת שגויה |
| `401` עם טוקן של מסגרת | הטוקן פג (ה-SDK מחדש) או שההתקנה הושבתה / הוסרה / נעצרה |
| `403 insufficient_scope` | המנהל לא אישר את ההרשאה (או שגרסה חדשה מחכה לאישור) |
| `403 not_for_extensions` | הנתיב מחוץ לרשימה המותרת לתוספים (בכוונה) |
| `404` על לוח | הלוח לא מאושר להתקנה, או שהמשתמש לא רואה אותו |
| "החיבור נכשל" במסך הניהול | השרת לא ענה `2xx` תוך 10 שניות; לתקן וללחוץ **חיבור מחדש** |
