// SPDX-License-Identifier: AGPL-3.0-only
import { sectionFromPreset } from './catalog';
import { idocSettingsSchema, type IdocSection, type IdocSettings } from './sections';

/**
 * Starter templates an account can add from the template gallery (canvas part 3). They are copied into the
 * account as ordinary templates — every text, section and setting is then the account's to change. Column
 * mappings start empty: the builder's "set up columns" fills them for a board.
 */
export type IdocStarter = {
  key: string;
  name: { he: string; en: string };
  description: { he: string; en: string };
  sections: IdocSection[];
  settings: IdocSettings;
};

const build = (entries: [string, Record<string, unknown>?][]): IdocSection[] =>
  entries.map(([preset, patch], i) => {
    const s = sectionFromPreset(preset, `s${i + 1}`);
    if (!s) throw new Error(`unknown preset ${preset}`);
    return { ...s, ...(patch ?? {}) } as IdocSection;
  });

const TERMS = [
  'הצדדים: {account.name} (להלן: "נותן השירות") והלקוח המפורט בראש המסמך (להלן: "הלקוח"). אישור הלקוח למסמך זה, בחתימה או בכתב, מהווה הסכמה לתנאים אלה.',
  'היקף העבודה: העבודה כוללת את הרכיבים הכלולים ואת התוספות שסומנו בלבד. כל דבר שאינו כלול במפורש אינו חלק מההסכם.',
  'שינויים ותוספות: כל שינוי בהיקף יתומחר בנפרד ויבוצע רק לאחר אישור הלקוח בכתב. שינויים עשויים להשפיע על לוח הזמנים.',
  'תשלום: לפי תנאי התשלום המפורטים במסמך. המחירים אינם כוללים מע"מ, אלא אם צוין אחרת. פיגור בתשלום מקנה לנותן השירות זכות להשהות את העבודה עד להסדרתו.',
  'שיתוף פעולה: הלקוח ימסור בזמן סביר את הגישות, המידע וההחלטות הנדרשים. עיכוב מצד הלקוח או צד שלישי מאריך את לוח הזמנים בהתאם.',
  'בדיקה ואישור: לאחר מסירת כל רכיב, הלקוח ידווח בכתב על ליקויים בתוך 14 ימים. רכיב שלא דווחו עליו ליקויים במועד, או שהוכנס לשימוש שוטף, ייחשב כמאושר.',
  'אחריות ותמיכה: נותן השירות יתקן ללא תשלום תקלות שמקורן בעבודתו בתקופת האחריות. האחריות אינה חלה על שינויים שביצעו הלקוח או צד שלישי.',
  'פלטפורמות צד שלישי: נותן השירות אינו אחראי לזמינות, לשינויים או לתקלות בשירותים של צדדים שלישיים. התאמה לשינויים כאלה תתומחר בנפרד.',
  'מידע ופרטיות: הלקוח הוא הבעלים של המידע והאחראי לקבלת ההסכמות הנדרשות לפי דין. נותן השירות מעבד את המידע רק לצורך מתן השירות.',
  'הגבלת אחריות: נותן השירות לא יהיה אחראי לנזק עקיף או תוצאתי. אחריותו הכוללת לא תעלה על הסכום ששולם לו בפועל בגין הרכיב הנדון.',
  'קניין רוחני: עם תשלום מלא, הלקוח יקבל את הבעלות בתוצרים שפותחו עבורו במיוחד. כלים, תבניות וידע כלליים נשארים של נותן השירות.',
  'סודיות: כל צד ישמור בסודיות מידע של הצד השני שהגיע אליו במסגרת העבודה, גם לאחר סיום ההסכם.',
  'סיום: כל צד רשאי לסיים את ההסכם בהודעה בכתב. הלקוח ישלם על העבודה שבוצעה עד מועד הסיום.',
  'כללי: מסמך זה הוא ההסכם המלא בין הצדדים, ועליו יחולו דיני מדינת ישראל. כל שינוי בו ייעשה בכתב.',
].join('\n\n');

const settings = (patch: Partial<IdocSettings> = {}) => idocSettingsSchema.parse(patch);

export const IDOC_STARTERS: IdocStarter[] = [
  {
    key: 'quote_agreement',
    name: { he: 'הצעת מחיר והסכם', en: 'Quote and agreement' },
    description: {
      he: 'כותרת, רקע, בסיס, תוספות לבחירה, מנוי, צד שלישי, סיכום, תנאים, שאלות וחתימה',
      en: 'Header, background, base, add-ons, subscription, third party, summary, terms, questions, signature',
    },
    sections: build([
      ['header', { title: '{item.name}', subtitle: 'הצעת מחיר והסכם שירות' }],
      ['background', { body: 'הצעה זו מבוססת על מה שסיכמנו. היא בנויה מחבילת בסיס ומתוספות לבחירתכם.' }],
      ['fixed_lines'],
      ['out_of_scope', { body: 'כל רכיב שאינו מופיע במסמך זה. רכיבים נוספים מוצעים כתוספות בהמשך.' }],
      ['addons', { intro: 'סמנו את התוספות הרצויות. המחירים חד-פעמיים ולפני מע"מ, אלא אם צוין אחרת.' }],
      ['subscription'],
      ['third_party', { intro: 'עלויות אלה משולמות ישירות לספקים ואינן בשליטת נותן השירות.' }],
      ['summary'],
      ['payment_schedule'],
      ['text', { title: 'לוח זמנים', body: '' }],
      ['terms', { body: TERMS }],
      ['attachments'],
      ['questions'],
      ['sign'],
    ]),
    settings: settings(),
  },
  {
    key: 'service_agreement',
    name: { he: 'הסכם שירות', en: 'Service agreement' },
    description: { he: 'כותרת, סעיפים, שדות מהפריט וחתימה', en: 'Header, clauses, item fields and signature' },
    sections: build([
      ['header', { subtitle: 'הסכם שירות' }],
      ['fields', { title: 'פרטים' }],
      ['terms', { body: TERMS, collapsed: false }],
      ['questions'],
      ['sign'],
    ]),
    settings: settings({ expires_days: null }),
  },
  {
    key: 'spec_approval',
    name: { he: 'אישור אפיון', en: 'Spec approval' },
    description: {
      he: 'כותרת, טקסט, נספחים, לוח זמנים, שאלות ואישור',
      en: 'Header, text, attachments, schedule, questions, approval',
    },
    sections: build([
      ['header', { subtitle: 'אישור אפיון' }],
      ['solution'],
      ['attachments'],
      ['schedule'],
      ['questions'],
      ['sign', { title: 'אישור האפיון' }],
    ]),
    settings: settings(),
  },
  {
    key: 'selection_form',
    name: { he: 'טופס בחירה', en: 'Selection form' },
    description: {
      he: 'כותרת, טבלת בחירה, סיכום ואישור בלי חתימה',
      en: 'Header, choices, summary, approve without signing',
    },
    sections: build([['header'], ['addons', { title: 'בחרו' }], ['summary'], ['approve_only']]),
    settings: settings({ expires_days: null }),
  },
  {
    key: 'blank',
    name: { he: 'מסמך ריק', en: 'Blank' },
    description: { he: 'כותרת בלבד', en: 'A header only' },
    sections: build([['header']]),
    settings: settings(),
  },
];

export const idocStarter = (key: string) => IDOC_STARTERS.find((s) => s.key === key);
