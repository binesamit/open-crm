// SPDX-License-Identifier: AGPL-3.0-only
import { createHmac } from 'node:crypto';
import {
  answered,
  applicableQuestions,
  AppError,
  conditionMet,
  type FormAnswer,
  formFileLimitsSchema,
  formInputOf,
  fileKindOf,
  newId,
  type PublicForm,
  type PublicQuestion,
  type PublicSubmitInput,
  type FormQuestion,
  type FormSettings,
  columnTypes,
  secretSettingsOf,
  itemTemplateAnswerFromCell,
} from '@bines/shared';
import { assertAccountOpen, assertFeature } from '../billing/entitlements';
import type { z } from 'zod';
import type { publicUploadSchema } from '@bines/shared';
import type { Db } from '../../db/client';
import type { AppDeps, SessionUser } from '../../types';
import { runInActivityScope } from '../../lib/activity-scope';
import { imageLink, isInlineSafeMime } from '../../lib/storage';
import { findAccountById, findMembership, type AccountRow } from '../accounts/accounts.repo';
import { formActor, hiddenSourceOf, linkableItems, resolveHidden } from './forms.hidden';
import { listColumns, type ColumnRow } from '../boards/boards.repo';
import { assetsByIds, findAsset, insertAsset, itemsHoldingAsset, markUploaded } from '../files/files.repo';
import { attachToCell, safeName } from '../files/files.service';
import { createItem } from '../items/items.service';
import { isAccountMember } from '../items/items.repo';
import { type Converted, convertAnswer } from './forms.values';
import { SECRET_ANSWER_MARK, writeFormSecrets } from './forms.secrets';
import { findItemTemplate } from '../item-templates/item-templates.repo';
import { applyItemTemplate, variablesOf } from '../item-templates/item-templates.service';
import { activeMemberNames, countSubmissions, findLiveFormByToken, type FormRow, insertSubmission } from './forms.repo';
import { captchaKeysOfForm, questionsOf, settingsOf } from './forms.service';
import { assertCaptcha } from '../captcha/captcha.service';
import { accountCountry } from '../phone/phone.service';

type Deps = Pick<AppDeps, 'db' | 'storage' | 'secrets' | 'env'> & Partial<Pick<AppDeps, 'logger'>>;
export type Visitor = { user: SessionUser | null; ip: string | null; userAgent: string | null };

/** A public token is `[a-z0-9]{6,64}`; anything else is simply not found. */
export const isFormToken = (token: string) => /^[a-z0-9]{6,64}$/.test(token);

/**
 * The form behind a token, for this visitor — or a 404 when it does not exist, is off, its account is gone or
 * suspended, or it is for members and the visitor is signed in but not one (no existence leak). A members-only
 * form asks an anonymous visitor to sign in (401). Past its close date or limit it is "closed" (409).
 */
const loadForm = async (db: Db, token: string, visitor: Visitor) => {
  if (!isFormToken(token)) throw new AppError('not_found', 'Form not found');
  const hit = await findLiveFormByToken(db, token);
  if (!hit || !hit.form.isActive) throw new AppError('not_found', 'Form not found');
  const form = hit.form;
  const account = await findAccountById(db, form.accountId);
  if (!account || account.status !== 'active') throw new AppError('not_found', 'Form not found');
  // plan-lock: a closed account's forms take no answers (403 account_closed; the form and its answers are kept).
  await assertAccountOpen(db, form.accountId);
  // Plans: public forms are the plan's `forms` — off the plan, the link stops taking answers (the
  // form, its settings and every submission stay).
  await assertFeature(db, form.accountId, 'forms');
  let memberId: string | null = null;
  if (visitor.user) {
    const m = await findMembership(db, form.accountId, visitor.user.id);
    if (m?.status === 'active') memberId = visitor.user.id;
  }
  if (form.requireLogin) {
    if (!visitor.user) throw new AppError('unauthenticated', 'sign_in_required');
    if (!memberId) throw new AppError('not_found', 'Form not found');
  }
  const settings = settingsOf(form);
  const closed =
    (settings.close_at && Date.parse(settings.close_at) <= Date.now()) ||
    (settings.max_submissions !== null && (await countSubmissions(db, form.id)) >= settings.max_submissions);
  if (closed) throw new AppError('form_closed', 'This form is closed', { title: form.title });
  return { form, account, settings, memberId };
};

/** The live board columns by key. */
const columnMap = async (db: Db, form: FormRow) =>
  new Map((await listColumns(db, form.boardId)).map((c) => [c.key, c]));

/**
 * The questions this visitor may answer, each with its column: hidden ones drop out (their defaults are applied on
 * submit); people questions exist only on members-only forms; a question whose column is gone drops out. A
 * condition on a hidden question is decided here with its default, so the page never needs hidden values.
 */
const visibleQuestions = (form: FormRow, columns: Map<string, ColumnRow>) => {
  const all = questionsOf(form).filter((q) => columns.has(q.column_key));
  const hidden = new Map(all.filter((q) => q.hidden).map((q) => [q.id, q]));
  const out: { q: FormQuestion; column: ColumnRow }[] = [];
  for (const q of all) {
    if (q.hidden) continue;
    const column = columns.get(q.column_key)!;
    // Hidden-only columns (connect boards) are never asked.
    if (!formInputOf(column.type)) continue;
    if (formInputOf(column.type) === 'people' && !form.requireLogin) continue;
    let condition = q.condition;
    const target = condition ? hidden.get(condition.question_id) : undefined;
    if (condition && target) {
      if (!conditionMet(condition, target.default_value)) continue;
      condition = null;
    }
    out.push({ q: { ...q, condition }, column });
  }
  return out;
};

type Labels = { labels?: { id: number; label: string; color?: string; index?: number; is_deactivated?: boolean }[] };

const publicQuestion = (
  q: FormQuestion,
  column: ColumnRow,
  members: { id: string; name: string; email: string }[] | null,
): PublicQuestion => {
  const input = formInputOf(column.type)!;
  const base: PublicQuestion = {
    id: q.id,
    input,
    label: q.label || column.title,
    help: q.help,
    required: q.required,
    condition: q.condition,
  };
  if (input === 'secret') {
    const s = secretSettingsOf(column.settings);
    return { ...base, secret: s.kind === 'checkbox' ? 'checkbox' : s.multiline ? 'multiline' : 'text' };
  }
  const labels = ((column.settings as Labels | null)?.labels ?? []).filter((l) => !l.is_deactivated);
  if (input === 'choice')
    return {
      ...base,
      choices: [...labels]
        .sort((a, b) => (a.index ?? a.id) - (b.index ?? b.id))
        .filter((l) => l.label.trim())
        .map((l) => ({ value: l.id, label: l.label, ...(l.color ? { color: l.color } : {}) })),
    };
  if (input === 'multi_choice')
    return { ...base, multiple: true, choices: labels.map((l) => ({ value: l.id, label: l.label })) };
  if (input === 'people')
    return {
      ...base,
      multiple: true,
      choices: (members ?? []).map((m) => ({ value: m.id, label: m.name || m.email })),
    };
  if (input === 'rating') return { ...base, rating_max: (column.settings as { max?: number } | null)?.max ?? 5 };
  if (input === 'files') return { ...base, files: q.files ?? formFileLimitsSchema.parse({}) };
  return base;
};

/** A short-lived link to show an image of the account (logo / cover) — only an inline-safe image of its own. */
const imageUrl = async (deps: Deps, accountId: string, assetId: string | null | undefined) => {
  if (!assetId) return null;
  const asset = await findAsset(deps.db, accountId, assetId);
  if (!asset?.storageKey || asset.uploadStatus !== 'uploaded' || !isInlineSafeMime(asset.mime)) return null;
  if (!asset.mime.startsWith('image/')) return null;
  return imageLink(deps.storage, asset.storageKey, asset.fileName, { inline: true, ttl: 3600 });
};

const brandOf = async (deps: Deps, account: AccountRow) => ({
  name: account.name,
  logo_url: await imageUrl(deps, account.id, account.logoAssetId),
});

/** GET /public/forms/:token */
export const getPublicForm = async (deps: Deps, token: string, visitor: Visitor): Promise<PublicForm> => {
  const { form, account, settings } = await loadForm(deps.db, token, visitor);
  const columns = await columnMap(deps.db, form);
  const questions = visibleQuestions(form, columns);
  const members = questions.some(({ column }) => formInputOf(column.type) === 'people')
    ? await activeMemberNames(deps.db, form.accountId)
    : null;
  const captcha = await captchaKeysOfForm(deps.db, form);
  return {
    title: form.title,
    description: form.description ?? '',
    language: settings.language,
    access: form.requireLogin ? 'members' : 'public',
    logo_url: await imageUrl(deps, form.accountId, settings.logo_asset_id),
    cover_url: await imageUrl(deps, form.accountId, settings.cover_asset_id),
    account: settings.show_account_branding ? await brandOf(deps, account) : null,
    questions: questions.map(({ q, column }) => publicQuestion(q, column, members)),
    submit_label: settings.submit_label,
    privacy_notice: settings.privacy_notice ?? '',
    turnstile_site_key: captcha?.site_key ?? null,
  };
};

/** Where a form's uploads live in storage: the prefix proves an upload was made for this form. */
const uploadPrefix = (form: FormRow) => `${form.accountId}/form-${form.id}/`;

const kindAllowed = (kinds: string[], f: { name: string; mime: string }) =>
  !kinds.length || kinds.includes(fileKindOf(f));

/** POST /public/forms/:token/uploads — a presigned PUT for one file of a file question (limits checked). */
export const presignFormUpload = async (
  deps: Deps,
  token: string,
  visitor: Visitor,
  input: z.infer<typeof publicUploadSchema>,
) => {
  const { form, account } = await loadForm(deps.db, token, visitor);
  const columns = await columnMap(deps.db, form);
  const hit = visibleQuestions(form, columns).find(({ q }) => q.id === input.question_id);
  if (!hit || formInputOf(hit.column.type) !== 'files') throw new AppError('not_found', 'Question not found');
  const limits = hit.q.files ?? formFileLimitsSchema.parse({});
  if (input.size > limits.max_mb * 1024 * 1024)
    throw new AppError('payload_too_large', 'File too large', { max_mb: limits.max_mb });
  const mime = input.mime || 'application/octet-stream';
  if (!kindAllowed(limits.kinds, { name: input.name, mime }))
    throw new AppError('invalid_value', 'File type not allowed', { kinds: limits.kinds });
  const actor = await formActor(deps.db, form, account, 'form');
  const id = newId();
  const key = `${uploadPrefix(form)}${id}/${safeName(input.name)}`;
  await insertAsset(deps.db, {
    id,
    accountId: form.accountId,
    ownerId: actor.user.id,
    kind: 'file',
    storageKey: key,
    fileName: input.name.slice(0, 255),
    mime,
    size: input.size,
    uploadStatus: 'pending',
  });
  const put = await deps.storage.presignPut(key, mime, input.size);
  return { upload_id: id, upload_url: put.url, method: 'PUT' as const, headers: put.headers };
};

/** A keyed hash of the address (the address itself is not stored). */
const hashIp = (env: Deps['env'], ip: string | null) =>
  ip
    ? createHmac('sha256', env.BETTER_AUTH_SECRET ?? 'bines-dev-forms')
        .update(ip)
        .digest('hex')
    : null;

/** "Chrome 120 · Android" from a User-Agent header (a summary for counting, never the raw header). */
export const summarizeUserAgent = (ua: string | null): string | null => {
  if (!ua) return null;
  const browser =
    /Edg\/(\d+)/.exec(ua)?.[1] !== undefined
      ? `Edge ${/Edg\/(\d+)/.exec(ua)![1]}`
      : /OPR\/(\d+)/.test(ua)
        ? `Opera ${/OPR\/(\d+)/.exec(ua)![1]}`
        : /Firefox\/(\d+)/.test(ua)
          ? `Firefox ${/Firefox\/(\d+)/.exec(ua)![1]}`
          : /Chrome\/(\d+)/.test(ua)
            ? `Chrome ${/Chrome\/(\d+)/.exec(ua)![1]}`
            : /Version\/(\d+).*Safari/.test(ua)
              ? `Safari ${/Version\/(\d+)/.exec(ua)![1]}`
              : /bot|crawl|spider/i.test(ua)
                ? 'Bot'
                : 'Other';
  const os = /Android/.test(ua)
    ? 'Android'
    : /iPhone|iPad|iPod/.test(ua)
      ? 'iOS'
      : /Windows/.test(ua)
        ? 'Windows'
        : /Mac OS X/.test(ua)
          ? 'macOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : null;
  return (os ? `${browser} · ${os}` : browser).slice(0, 120);
};

type QuestionError = 'required' | 'invalid' | 'too_many_files' | 'file_too_large' | 'file_type';

/** POST /public/forms/:token/submit — validates every answer, then creates the item through the items service. */
export const submitForm = async (deps: Deps, token: string, visitor: Visitor, input: PublicSubmitInput) => {
  const { db } = deps;
  const { form, account, settings, memberId } = await loadForm(db, token, visitor);
  const result = {
    ok: true as const,
    message: settings.success_message,
    redirect_url: settings.redirect_url || null,
  };
  // Honeypot: a bot filled the field people never see — it gets the same answer and nothing is created.
  if (input.website?.trim()) return result;
  // Turnstile: the form's mode, else the account's; its own keys, else the account's.
  await assertCaptcha(deps.secrets, await captchaKeysOfForm(db, form), input.turnstile_token, visitor.ip);

  const columns = await columnMap(db, form);
  const all = questionsOf(form).filter((q) => columns.has(q.column_key));
  const visible = new Set(visibleQuestions(form, columns).map(({ q }) => q.id));
  // What the page sent counts only for questions it shows; hidden questions take their value from the form's setup.
  const merged: Record<string, FormAnswer | undefined> = {};
  for (const q of all) merged[q.id] = q.hidden || !visible.has(q.id) ? undefined : input.answers[q.id];
  // Conditions never depend on hidden questions, so which ones apply is known before their values are.
  const applicable = applicableQuestions(
    all.filter((q) => q.hidden || visible.has(q.id)),
    merged,
  );
  const actor = await formActor(db, form, account, `form:${form.id}`);

  const errors: Record<string, QuestionError> = {};
  let linkError = false;
  const fromLink = new Set<string>();
  let emails: Map<string, string> | null = null;
  const memberEmails = async () =>
    (emails ??= new Map((await activeMemberNames(db, form.accountId)).map((m) => [m.email.toLowerCase(), m.id])));
  for (const q of applicable.filter((x) => x.hidden)) {
    const r = await resolveHidden(db, actor, q, columns.get(q.column_key)!, input.params ?? {}, memberEmails);
    merged[q.id] = r.answer;
    if (r.fromLink) fromLink.add(q.id);
  }
  /**
   * A value that does not fit: refused like any answer — except a value read from a source item, which never blocks
   * the person (that cell is left empty; the item may have changed since the form was set up).
   */
  const invalid = (q: FormQuestion) => {
    if (q.hidden && hiddenSourceOf(q) === 'item') return;
    errors[q.id] = 'invalid';
    if (fromLink.has(q.id)) linkError = true;
  };
  let name: string | null = null;
  const cells: Record<string, unknown> = {};
  // secret answers — written encrypted onto the new item, nowhere else.
  const secrets: { column: ColumnRow; value: string }[] = [];
  const files: { column: ColumnRow; ids: string[] }[] = [];
  // Each answer as converted (an item template's variables read them, below).
  const converted = new Map<string, { c: Converted; column: ColumnRow }>();
  for (const q of applicable) {
    const column = columns.get(q.column_key)!;
    const answer = merged[q.id];
    if (!answered(answer)) {
      if (q.required) errors[q.id] = 'required';
      continue;
    }
    const c = convertAnswer(
      column,
      answer!,
      column.type === 'phone' ? { country: await accountCountry(db, form.accountId) } : {},
    );
    if (!c.ok) {
      invalid(q);
      continue;
    }
    converted.set(q.id, { c, column });
    if (c.kind === 'name') name = c.value;
    else if (c.kind === 'cell') {
      if (c.value !== null) cells[column.key] = c.value;
    } else if (c.kind === 'secret') {
      if (q.hidden) invalid(q);
      else secrets.push({ column, value: c.value });
    } else if (c.kind === 'people') {
      // Members-only forms list the account's people; anything else is refused. A hidden value is the form's own
      // (or a link's): it must name the account's people, on any form.
      if ((!q.hidden && !memberId) || !(await isAccountMember(db, form.accountId, c.ids))) invalid(q);
      else if (c.ids.length) cells[column.key] = { persons_and_teams: c.ids.map((id) => ({ id, kind: 'person' })) };
    } else if (c.kind === 'links') {
      // Connect boards (hidden only): items the form's creator can read, on the column's boards.
      if (!q.hidden || !(await linkableItems(db, actor, column, c.ids))) invalid(q);
      else if (c.ids.length) cells[column.key] = { item_ids: c.ids };
    } else {
      const limits = q.files ?? formFileLimitsSchema.parse({});
      if (c.ids.length > limits.max_files) {
        errors[q.id] = 'too_many_files';
        continue;
      }
      const err = await checkUploads(deps, form, c.ids, limits);
      if (err) errors[q.id] = err;
      else if (c.ids.length) files.push({ column, ids: c.ids });
    }
  }
  if (Object.keys(errors).length)
    throw new AppError('validation_failed', 'Some answers are missing or invalid', {
      questions: errors,
      // A value of the link itself does not fit (the page says the link is not valid).
      ...(linkError ? { link: true } : {}),
    });

  const groupId = form.targetGroupId ?? undefined;
  const itemName = name ?? form.title;
  // Every activity row of this submission says "via form <title>" and shares one batch (one action).
  const batchId = newId();
  const template = await formTemplate(db, form, settings);
  const item = await runInActivityScope(
    { batchId, meta: { via: 'form', form: { id: form.id, title: form.title } } },
    async () => {
      // Prod (phase 2): the item from the form's template — its tree, with the answers as the item's own
      // values (they win over the template's) and the template's variables answered by the mapped questions.
      const created = template
        ? {
            id: (
              await applyItemTemplate(
                deps,
                actor,
                template.row.id,
                {
                  ...(groupId ? { group_id: groupId } : {}),
                  position: 'bottom',
                  variables: templateAnswers(template, converted),
                },
                { batchId, missingOk: true, overrides: { ...(name ? { name } : {}), cells } },
              )
            ).item_id,
          }
        : await createItem(db, actor, form.boardId, { name: itemName, group_id: groupId, cells });
      for (const f of files) {
        await attachToCell(deps, actor, created.id, f.column.key, f.ids);
      }
      if (secrets.length) await writeFormSecrets(deps, actor, created.id, secrets, { batchId, form, visitor });
      return created;
    },
  );
  await insertSubmission(db, {
    id: newId(),
    accountId: form.accountId,
    formId: form.id,
    itemId: item.id,
    submittedBy: memberId,
    ipHash: hashIp(deps.env, visitor.ip),
    userAgent: summarizeUserAgent(visitor.userAgent),
    // The raw answers the person gave (uploads are on the item; a secret only says that one was given).
    answers: Object.fromEntries(
      applicable
        .filter((q) => !q.hidden && formInputOf(columns.get(q.column_key)!.type) !== 'files')
        .map((q) => [
          q.id,
          formInputOf(columns.get(q.column_key)!.type) === 'secret'
            ? answered(merged[q.id])
              ? SECRET_ANSWER_MARK
              : null
            : (merged[q.id] ?? null),
        ]),
    ),
  });
  return result;
};

/**
 * The form's item template (phase 2), when it is still there on the form's board — one deleted since
 * makes a plain item again (a submission is never refused for the form's setup).
 */
const formTemplate = async (db: Db, form: FormRow, settings: FormSettings) => {
  const setting = settings.item_template;
  if (!setting) return null;
  const row = await findItemTemplate(db, form.accountId, setting.template_id);
  if (!row || row.boardId !== form.boardId) return null;
  return { row, vars: variablesOf(row), sources: setting.variables };
};

/** The template's variables from the mapped questions' answers (unanswered = the variable's default). */
const templateAnswers = (
  template: NonNullable<Awaited<ReturnType<typeof formTemplate>>>,
  converted: Map<string, { c: Converted; column: ColumnRow }>,
) => {
  const out: Record<string, string | string[]> = {};
  for (const v of template.vars) {
    const qid = template.sources[v.key];
    const hit = qid ? converted.get(qid) : undefined;
    if (!hit?.c.ok) continue;
    const { c, column } = hit;
    let answer: string | string[] | undefined;
    if (c.kind === 'people') answer = v.type === 'person' && c.ids.length ? c.ids : undefined;
    else if (c.kind === 'name') answer = v.type === 'text' ? c.value : undefined;
    else if (c.kind === 'cell') {
      let text: string | null = null;
      try {
        text = columnTypes.get(column.type)?.toText(c.value as never, column.settings as never, {}) ?? null;
      } catch {
        text = null;
      }
      answer = itemTemplateAnswerFromCell(v.type, { type: column.type, value: c.value, text });
    }
    if (answer !== undefined) out[v.key] = answer;
  }
  return out;
};

/**
 * Uploads named in a submission: made for this form (storage prefix), not used anywhere yet, really in storage,
 * and within the question's limits. Marks them uploaded so the files module can attach them.
 */
const checkUploads = async (
  deps: Deps,
  form: FormRow,
  ids: string[],
  limits: { max_mb: number; kinds: string[] },
): Promise<QuestionError | null> => {
  const rows = await assetsByIds(deps.db, form.accountId, ids);
  if (rows.length !== ids.length) return 'invalid';
  for (const r of rows) {
    if (!r.storageKey?.startsWith(uploadPrefix(form))) return 'invalid';
    // One upload, one submission: a file already on an item cannot be sent again.
    if ((await itemsHoldingAsset(deps.db, r.id)).length) return 'invalid';
    if (r.uploadStatus === 'uploaded') continue;
    const head = await deps.storage.head(r.storageKey);
    if (!head) return 'invalid';
    if (head.size > limits.max_mb * 1024 * 1024) return 'file_too_large';
    if (!kindAllowed(limits.kinds, { name: r.fileName, mime: head.mime || r.mime })) return 'file_type';
    await markUploaded(deps.db, r.id, head.size, head.mime || r.mime);
  }
  return null;
};
