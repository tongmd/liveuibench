// Seed benchmark fixtures into the running AppWorld world (:9000).
// Fixture files: benchmarks/fixtures/<case-id>.json
//   { "people": [{ "firstName": "Nina", "lastName": "Park", "email": "nina@example.com",
//                  "phone": "5550100201", "apps": ["venmo", "splitwise"] }] }
// 意图里指名道姓的第三方(Carla/Nina/Greer...)在基础世界里不存在,写调用会
// "user does not exist"。评测前把他们注册成真实账号,用例才可赢。
// 注册流程与 appworld-bridge 的 oracle 一致:gmail 免验证作身份根,其余应用
// signup → 到该身份的 gmail 收验证码 → verify。
//
// ADMIN-LEVEL 注入(实测自 appworld 0.1.3.post1 源码):
// - POST /date_time {date_and_time} → {time_freezer_id};DELETE /date_time
//   {time_freezer_id} 弹回基准冻结(2023-05-18T12:00)。冻结期间写入的行
//   created_at 被回溯。铁律:token 必须在同一冻结窗口内登录取得并只在窗口内
//   使用 —— 冻结内签发的 token 解冻后即过期,绝不跨窗口复用。
// - POST /admin/payment_card(无鉴权 admin 应用)写入银行注册表,venmo/amazon
//   attach 卡时经 /admin/validate_card 校验的就是这张表。
import fs from 'node:fs/promises';
import path from 'node:path';
import {deliverOrdersInManagedWorld,type DeliveryRequest} from './appworld-delivery.js';

const preparationWarnings: string[] = [];
const originalWarn = console.warn;
console.warn = (...items: unknown[]) => { preparationWarnings.push(items.map(String).join(' ')); originalWarn(...items); };

const API = process.env.APPWORLD_API_BASE || 'http://127.0.0.1:9000';

type Person = { firstName: string; lastName: string; email: string; phone: string; apps: string[] };
type NoteFixture = { title: string; content: string };
type FileFixture = { path: string; content: string };
type EmailFixture = { from: string; to: string | string[]; subject: string; body: string; replies?: Array<{ from: string; body: string }> };
type ContactFixture = { firstName: string; lastName: string; phone: string; email?: string; birthday?: string; relationship?: string };
// ---- admin-level fixture types ----
type AdminCardFixture = { ownerEmail?: string; cardName: string; ownerName: string; cardNumber: number; expiryYear: number; expiryMonth: number; cvv: number; bankBalance: number };
type VenmoBalanceFixture = { at?: string; amount: number };
type VenmoTransactionFixture = { at: string; fromEmail: string; toEmail: string; amount: number; description: string };
type VenmoIncomingRequestFixture = { at: string; fromEmail: string; amount: number; description: string };
type BackdatedEmailFixture = EmailFixture & { at: string };
type SmsFixture = { at: string; fromPhone: string; toPhone: string; message: string };
type TodoistProjectFixture = { at: string; ownerEmail: string; name: string; tasks?: Array<{ content: string; due?: string }>; collaborators?: string[] };
type AmazonOrderFixture = { at: string; items: Array<{ query: string; qty?: number }>; address: { name?: string; streetAddress: string; city: string; state: string; country: string; zipCode: number }; delivered?: boolean; deliveredAt?: string };

// oracle 身份与 appworld-bridge 保持一字不差:预置"用户自己的历史数据"要写进
// 评测时 bridge 登录的同一个账号。
const ORACLE: Person = { firstName: 'Guios', lastName: 'Oracle', email: 'oracle@guios.dev', phone: '5550100001', apps: [] };
const ORACLE_PASSWORD = 'guios-oracle-1';
const FIXTURE_PASSWORD = 'fixture-pass-1';
// admin/payment_card 要求 main_user_id>0;银行注册表只按卡字段校验,归属谁的
// main user 不影响 validate/debit/credit,固定用 1。
const ADMIN_MAIN_USER_ID = 1;

async function call(pathname: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${API}${pathname}`, init);
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) throw new Error(`${pathname} -> ${res.status}: ${text.slice(0, 200)}`);
  return body;
}

const jsonHeaders = (token?: string) => ({ 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) });

async function login(app: string, username: string, password: string): Promise<string | null> {
  try {
    const res = await call(`/${app}/auth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username, password }).toString(),
    });
    return String(res?.access_token || '') || null;
  } catch {
    return null;
  }
}

// 时间平移:冻结期内执行 fn,写入全部回溯 created_at。种子流程是进程级全局
// 冻结,必须严格串行(本文件所有循环均 await 顺序执行,勿并行化)。
async function timeShift<T>(iso: string | undefined, fn: () => Promise<T>): Promise<T> {
  if (!iso) return fn();
  const res = await call('/date_time', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ date_and_time: iso }) });
  const freezerId = res?.time_freezer_id;
  try {
    return await fn();
  } finally {
    await call('/date_time', { method: 'DELETE', headers: jsonHeaders(), body: JSON.stringify({ time_freezer_id: freezerId }) }).catch((e) => console.warn(`  timeShift unfreeze failed: ${e}`));
  }
}

async function readVerificationCode(app: string, gmailToken: string): Promise<string> {
  // 忙碌收件箱(种子邮件 24+)必须翻页找验证码 —— 桥同款教训。
  const matching: Array<Record<string, any>> = [];
  for (let page = 0; page < 5; page++) {
    const threads = await call(`/gmail/email_threads/category/inbox?page_limit=20&page_index=${page}`, {
      headers: { Authorization: `Bearer ${gmailToken}` },
    }).catch(() => []) as Array<Record<string, any>>;
    if (!threads?.length) break;
    matching.push(...threads.filter((thread) =>
      JSON.stringify(thread.participants || '').toLowerCase().includes(`@${app.replace(/_/g, '')}.com`)
      || String(thread.subject || '').toLowerCase().includes(app.replace(/_/g, ' '))));
    if (matching.length) break;
  }
  const emailIds = matching.flatMap((thread) => (Array.isArray(thread.email_ids) ? thread.email_ids : []));
  if (!emailIds.length) throw new Error(`no verification email for ${app}`);
  const latest = Math.max(...emailIds.map(Number));
  const email = await call(`/gmail/emails/${latest}`, { headers: { Authorization: `Bearer ${gmailToken}` } });
  const match = String(email?.body || '').match(/code is:\s*([A-Za-z0-9]+)/);
  if (!match) throw new Error(`no verification code in ${app} email ${latest}`);
  return match[1];
}

async function ensureAccount(person: Person, app: string, password: string): Promise<void> {
  const username = app === 'phone' ? person.phone : person.email;
  if (await login(app, username, password)) { console.log(`  ${app}: exists`); return; }
  const signupBody: Record<string, string> = {
    first_name: person.firstName,
    last_name: person.lastName,
    password,
    ...(app === 'phone' ? { phone_number: person.phone } : { email: person.email }),
  };
  await call(`/${app}/account`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signupBody) }).catch(() => null);
  if (await login(app, username, password)) { console.log(`  ${app}: signed up`); return; }
  if (app !== 'gmail') {
    // 需要邮箱验证:先保证该身份有 gmail,再收验证码
    await ensureAccount(person, 'gmail', password);
    const gmailToken = await login('gmail', person.email, password);
    if (!gmailToken) throw new Error(`gmail login failed for ${person.email}`);
    await call(`/${app}/send_verification_code`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: person.email }) }).catch(() => null);
    const code = await readVerificationCode(app, gmailToken);
    await call(`/${app}/verify_account`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: person.email, verification_code: code }) });
  }
  const token = await login(app, username, password);
  if (!token) throw new Error(`${app} account for ${person.email} could not be established`);
  console.log(`  ${app}: signed up + verified`);
}

// ---- 身份工具:邮箱 → Person/密码(与 emails 预置一致的推导规则) ----
function makePersonFor(people: Map<string, Person>) {
  return (address: string): Person => {
    if (address === ORACLE.email) return ORACLE;
    const known = people.get(address);
    if (known) return known;
    return { firstName: address.split('@')[0].split(/[._-]/)[0] || 'Fixture', lastName: 'Sender', email: address, phone: '', apps: [] };
  };
}
const passwordFor = (address: string) => address === ORACLE.email ? ORACLE_PASSWORD : FIXTURE_PASSWORD;

// ---- admin 银行注册表 ----
async function adminCardRegistered(card: AdminCardFixture): Promise<boolean> {
  try {
    const res = await call('/admin/validate_card', {
      method: 'POST', headers: jsonHeaders(),
      body: JSON.stringify({ owner_name: card.ownerName, card_number: card.cardNumber, expiry_year: card.expiryYear, expiry_month: card.expiryMonth, cvv_number: card.cvv }),
    });
    return !!res?.valid;
  } catch { return false; }
}

async function ensureAdminCard(card: AdminCardFixture): Promise<void> {
  if (await adminCardRegistered(card)) { console.log(`  admin card exists: ${card.cardName} (*${String(card.cardNumber).slice(-4)})`); return; }
  await call('/admin/payment_card', {
    method: 'POST', headers: jsonHeaders(),
    body: JSON.stringify({
      main_user_id: ADMIN_MAIN_USER_ID,
      card_name: card.cardName,
      owner_name: card.ownerName,
      card_number: card.cardNumber,
      expiry_year: card.expiryYear,
      expiry_month: card.expiryMonth,
      cvv_number: card.cvv,
      balance: card.bankBalance,
    }),
  });
  console.log(`  admin card registered: ${card.cardName} (*${String(card.cardNumber).slice(-4)}, bank $${card.bankBalance})`);
}

// venmo/amazon 侧把注册表里的卡 attach 到账号;幂等按 card_number 匹配已有卡。
async function ensureCardAttached(app: 'venmo' | 'amazon', token: string, card: AdminCardFixture): Promise<number> {
  const cards = await call(`/${app}/payment_cards`, { headers: { Authorization: `Bearer ${token}` } }).catch(() => []) as Array<Record<string, any>>;
  const found = (cards || []).find((c) => Number(c.card_number) === Number(card.cardNumber));
  if (found) return Number(found.payment_card_id);
  const res = await call(`/${app}/payment_cards`, {
    method: 'POST', headers: jsonHeaders(token),
    body: JSON.stringify({ card_name: card.cardName, owner_name: card.ownerName, card_number: card.cardNumber, expiry_year: card.expiryYear, expiry_month: card.expiryMonth, cvv_number: card.cvv }),
  });
  return Number(res?.payment_card_id);
}

// fixture 人自动供卡:交易发送方需要余额时,派生确定性的卡注册+attach+充值,
// 全程在同一冻结窗口内完成。
function autoCardFor(person: Person): AdminCardFixture {
  let h = 0;
  for (const ch of person.email) h = (h * 31 + ch.charCodeAt(0)) % 100000000;
  return {
    ownerEmail: person.email,
    // admin 注册表校验 card_name ∈ {Visa, MasterCard, American Express, Discover, HSBC, Wells Fargo, Chase}
    cardName: 'Visa',
    ownerName: `${person.firstName} ${person.lastName}`.trim(),
    cardNumber: 4000000000000000 + (h % 99999999),
    expiryYear: 2027,
    expiryMonth: 12,
    cvv: 100 + (h % 900),
    bankBalance: 100000,
  };
}

async function ensureVenmoFunds(person: Person, token: string, needed: number): Promise<void> {
  const bal = await call('/venmo/balance', { headers: { Authorization: `Bearer ${token}` } });
  const current = Number(bal?.venmo_balance || 0);
  if (current >= needed) return;
  const card = autoCardFor(person);
  await ensureAdminCard(card);
  const cardId = await ensureCardAttached('venmo', token, card);
  const topUp = Math.round((needed - current + 1) * 100) / 100;
  await call('/venmo/balance', { method: 'POST', headers: jsonHeaders(token), body: JSON.stringify({ amount: topUp, payment_card_id: cardId }) });
  console.log(`    auto-funded ${person.email} +$${topUp}`);
}

// 单封邮件预置(含回复链),供普通 emails 与 backdatedEmails 复用。
async function seedOneEmail(mail: EmailFixture, seenSubjects: Set<string>, personFor: (a: string) => Person, ensureAccounts: boolean): Promise<void> {
  // 审计代理产出形状不齐:缺 from/to/subject 的条目跳过并示警,不炸整个种子流程。
  const recipients = (Array.isArray(mail?.to) ? mail.to : [mail?.to]).filter((x: unknown) => typeof x === 'string' && x) as string[];
  if (typeof mail?.subject !== 'string' || typeof mail?.from !== 'string' || !recipients.length || typeof mail?.body !== 'string') { console.warn(`  email fixture skipped (bad shape): ${JSON.stringify(mail).slice(0, 120)}`); return; }
  if (seenSubjects.has(mail.subject)) return;
  seenSubjects.add(mail.subject);
  const replies = (mail.replies ?? []).filter((reply) => reply?.from && reply?.body);
  if (ensureAccounts) {
    for (const address of [mail.from, ...recipients, ...replies.map((r) => r.from)]) {
      await ensureAccount(personFor(address), 'gmail', passwordFor(address));
    }
  }
  const fromToken = await login('gmail', mail.from, passwordFor(mail.from));
  if (!fromToken) throw new Error(`gmail login failed for ${mail.from}`);
  // 幂等:发件方 outbox(gmail 对"已发送"的命名,没有 /category/sent)里已有同主题线程则跳过
  const sent = await call('/gmail/email_threads/category/outbox?page_limit=20', { headers: { Authorization: `Bearer ${fromToken}` } }).catch(() => []) as Array<Record<string, any>>;
  if ((sent || []).some((thread) => String(thread.subject || '') === mail.subject)) { console.log(`  email exists: ${mail.subject}`); return; }
  await call('/gmail/emails', {
    method: 'POST',
    headers: jsonHeaders(fromToken),
    body: JSON.stringify({ email_addresses: recipients, subject: mail.subject, body: mail.body }),
  });
  // 线程 id 是每个账号一份拷贝:发件方的 sent_email_thread_id 对回复方不可用,
  // 回复必须从回复方自己的 inbox 按主题找线程。
  let threadId: any;
  let emailId: any;
  for (const reply of replies) {
    const replyToken = await login('gmail', reply.from, passwordFor(reply.from));
    if (!replyToken) throw new Error(`gmail login failed for ${reply.from}`);
    if (!threadId || !emailId) {
      // 从回复方视角找线程
      let thread: Record<string, any> | undefined;
      for (let page = 0; page < 5 && !thread; page++) {
        const inbox = await call(`/gmail/email_threads/category/inbox?page_limit=20&page_index=${page}`, { headers: { Authorization: `Bearer ${replyToken}` } }).catch(() => []) as Array<Record<string, any>>;
        if (!inbox?.length) break;
        thread = inbox.find((item) => String(item.subject || '') === mail.subject);
      }
      if (!thread) throw new Error(`reply thread not found: ${mail.subject}`);
      threadId = thread.email_thread_id ?? thread.id;
      emailId = Math.max(...(thread.email_ids ?? [0]).map(Number));
    }
    const replyRes = await call(`/gmail/email_threads/${threadId}/emails/${emailId}/reply`, {
      method: 'POST',
      headers: jsonHeaders(replyToken),
      body: JSON.stringify({ body: reply.body }),
    }) as Record<string, any>;
    emailId = replyRes?.email_id ?? emailId;
  }
  console.log(`  email seeded: ${mail.subject} (${replies.length} replies)`);
}

const byAt = (a: { at?: string }, b: { at?: string }) => String(a.at || '').localeCompare(String(b.at || ''));

async function main() {
  const dir = path.resolve('benchmarks/fixtures');
  // --only <case-id>:只种该用例的 fixture —— 全量种子会让每个应用开屏看到
  // 别的用例的预置(周报应用里冒出 Gift ideas 笔记),且 201 人全量注册拖慢每例重置。
  const onlyIdx = process.argv.indexOf('--only');
  const onlyId = onlyIdx !== -1 ? process.argv[onlyIdx + 1] : null;
  // --file <path>:直接指定单个 fixture 文件(临时验证/外部注入用),绕过目录扫描。
  const fileIdx = process.argv.indexOf('--file');
  const fileOverride = fileIdx !== -1 ? process.argv[fileIdx + 1] : null;
  if (!onlyId && !fileOverride) throw new Error('--only <public/dev case-id> or --file <fixture> required; bulk seeding is disabled');
  const dataset = JSON.parse(await fs.readFile(path.resolve('benchmarks/liveuibench.json'), 'utf8'));
  if (onlyId && !dataset.cases.some((c: any) => c.id === onlyId)) throw new Error('Unknown public/dev case ID');
  let filePaths: string[];
  if (fileOverride) {
    filePaths = [path.resolve(fileOverride)];
    console.log(`seeding scope: --file ${filePaths[0]}`);
  } else {
    const files = (await fs.readdir(dir).catch(() => [] as string[]))
      .filter((f) => f.endsWith('.json'))
      .filter((f) => !onlyId || f === `${onlyId}.json`);
    if (onlyId) console.log(`seeding scope: ${onlyId} (${files.length} fixture file)`);
    filePaths = files.map((f) => path.join(dir, f));
  }
  if (!filePaths.length) throw new Error('No fixture file found for the selected case');
  const people = new Map<string, Person>();
  const notes: NoteFixture[] = [];
  const fsFiles: FileFixture[] = [];
  const emails: EmailFixture[] = [];
  const contacts: ContactFixture[] = [];
  const adminCards: AdminCardFixture[] = [];
  const venmoBalances: VenmoBalanceFixture[] = [];
  const venmoTransactions: VenmoTransactionFixture[] = [];
  const venmoIncomingRequests: VenmoIncomingRequestFixture[] = [];
  const backdatedEmails: BackdatedEmailFixture[] = [];
  const smsMessages: SmsFixture[] = [];
  const todoistProjects: TodoistProjectFixture[] = [];
  const amazonOrders: AmazonOrderFixture[] = [];
  let spotifyLikeCount = 0;
  for (const filePath of filePaths) {
    const fixture = JSON.parse(await fs.readFile(filePath, 'utf8'));
    for (const person of fixture.people ?? []) {
      const existing = people.get(person.email);
      if (existing) existing.apps = Array.from(new Set([...existing.apps, ...person.apps]));
      else people.set(person.email, { ...person, apps: [...person.apps] });
    }
    notes.push(...(fixture.notes ?? []));
    fsFiles.push(...(fixture.files ?? []));
    emails.push(...(fixture.emails ?? []));
    contacts.push(...(fixture.contacts ?? []));
    adminCards.push(...(fixture.adminCards ?? []));
    venmoBalances.push(...(fixture.venmoBalance ?? []));
    venmoTransactions.push(...(fixture.venmoTransactions ?? []));
    venmoIncomingRequests.push(...(fixture.venmoIncomingRequests ?? []));
    backdatedEmails.push(...(fixture.backdatedEmails ?? []));
    smsMessages.push(...(fixture.sms ?? []));
    todoistProjects.push(...(fixture.todoistProjects ?? []));
    amazonOrders.push(...(fixture.amazonOrders ?? []));
    if (fixture.spotifyLikes?.count) spotifyLikeCount = Math.max(spotifyLikeCount, Number(fixture.spotifyLikes.count) || 0);
  }
  const adminWorkCount = adminCards.length + venmoBalances.length + venmoTransactions.length
    + venmoIncomingRequests.length + backdatedEmails.length + smsMessages.length
    + todoistProjects.length + amazonOrders.length;
  if (!people.size && !notes.length && !fsFiles.length && !emails.length && !contacts.length && !spotifyLikeCount && !adminWorkCount) { console.log('no fixtures to seed'); return; }
  const password = FIXTURE_PASSWORD;
  const personFor = makePersonFor(people);
  for (const person of people.values()) {
    console.log(`seeding ${person.firstName} ${person.lastName} <${person.email}>`);
    for (const app of ['gmail', ...person.apps.filter((a) => a !== 'gmail')]) {
      await ensureAccount(person, app, password);
    }
  }
  // oracle 自己的历史数据(过往笔记/已有文件):写进 bridge 将登录的同一账号。
  // 跨 fixture 文件按标题去重;已存在(409)视为幂等成功。
  if (notes.length) {
    await ensureAccount(ORACLE, 'simple_note', ORACLE_PASSWORD);
    const token = await login('simple_note', ORACLE.email, ORACLE_PASSWORD);
    if (!token) throw new Error('oracle simple_note login failed');
    const seenTitles = new Set<string>();
    for (const note of notes) {
      if (seenTitles.has(note.title)) continue;
      seenTitles.add(note.title);
      try {
        await call('/simple_note/notes', {
          method: 'POST',
          headers: jsonHeaders(token),
          body: JSON.stringify({ title: note.title, content: note.content }),
        });
        console.log(`  note seeded: ${note.title}`);
      } catch (error) {
        if (String((error as Error).message).includes('already exists')) console.log(`  note exists: ${note.title}`);
        else throw error;
      }
    }
  }
  if (fsFiles.length) {
    await ensureAccount(ORACLE, 'file_system', ORACLE_PASSWORD);
    const token = await login('file_system', ORACLE.email, ORACLE_PASSWORD);
    if (!token) throw new Error('oracle file_system login failed');
    for (const file of fsFiles) {
      await call('/file_system/file', {
        method: 'POST',
        headers: jsonHeaders(token),
        body: JSON.stringify({ file_path: file.path, content: file.content, overwrite: true }),
      });
      console.log(`  file seeded: ${file.path}`);
    }
  }
  // 邮件预置:sent/inbox 历史线程(等回复类用例的核心前置)。发件人/收件人先保证
  // gmail 账号,登录发件方真实发送;replies 用返回的线程 id 由对方真实回复。按主题去重/幂等。
  if (emails.length) {
    const seenSubjects = new Set<string>();
    for (const mail of emails) {
      await seedOneEmail(mail, seenSubjects, personFor, true);
    }
  }
  // 联系人预置:写进 oracle 的 phone 通讯录(生日追踪类用例的前置)。
  // 注意 email 必填的隐坑:openapi 标可选,但模型校验 email=None 会裸 500。
  if (contacts.length) {
    await ensureAccount(ORACLE, 'phone', ORACLE_PASSWORD);
    const token = await login('phone', ORACLE.phone, ORACLE_PASSWORD);
    if (!token) throw new Error('oracle phone login failed');
    const existing = await call('/phone/contacts?page_limit=20', { headers: { Authorization: `Bearer ${token}` } }).catch(() => []) as Array<Record<string, any>>;
    const have = new Set((existing || []).map((c) => String(c.phone_number || '')));
    for (const contact of contacts) {
      if (!contact?.firstName || !contact?.lastName || !contact?.phone) { console.warn(`  contact fixture skipped: ${JSON.stringify(contact).slice(0, 100)}`); continue; }
      if (have.has(contact.phone)) { console.log(`  contact exists: ${contact.firstName} ${contact.lastName}`); continue; }
      await call('/phone/contacts', {
        method: 'POST',
        headers: jsonHeaders(token),
        body: JSON.stringify({
          first_name: contact.firstName,
          last_name: contact.lastName,
          phone_number: contact.phone,
          email: contact.email || `${contact.firstName.toLowerCase()}.${contact.lastName.toLowerCase()}@example.com`,
          ...(contact.birthday ? { birthday: contact.birthday } : {}),
          ...(contact.relationship ? { relationships: [contact.relationship] } : {}),
        }),
      });
      console.log(`  contact seeded: ${contact.firstName} ${contact.lastName}`);
    }
  }
  // 已喜欢歌曲积压(曲库整理类用例前置):oracle spotify 账号按目录顺序点赞 N 首,幂等。
  if (spotifyLikeCount > 0) {
    await ensureAccount(ORACLE, 'spotify', ORACLE_PASSWORD);
    const token = await login('spotify', ORACLE.email, ORACLE_PASSWORD);
    if (!token) throw new Error('oracle spotify login failed');
    const liked = await call('/spotify/liked_songs?page_limit=20', { headers: { Authorization: `Bearer ${token}` } }).catch(() => []) as Array<Record<string, any>>;
    const have = Array.isArray(liked) ? liked.length : 0;
    if (have >= Math.min(spotifyLikeCount, 20)) {
      console.log(`  spotify likes exist: >=${have}`);
    } else {
      let likedTotal = 0;
      for (let page = 0; page < 5 && likedTotal < spotifyLikeCount; page++) {
        const songs = await call(`/spotify/songs?page_limit=20&page_index=${page}`, { headers: { Authorization: `Bearer ${token}` } }).catch(() => []) as Array<Record<string, any>>;
        if (!songs?.length) break;
        for (const song of songs) {
          if (likedTotal >= spotifyLikeCount) break;
          await call(`/spotify/songs/${song.song_id}/like`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } }).catch(() => null);
          likedTotal++;
        }
      }
      console.log(`  spotify likes seeded: ${likedTotal}`);
    }
  }

  // ============ ADMIN-LEVEL 注入 ============
  // 账号注册一律在冻结窗口之外先做完(注册/验证码流程慢且会发系统邮件,不需要
  // 回溯);冻结窗口内只做 login + 业务写入。

  // -- adminCards:银行注册表 + 可选 attach 到 venmo/amazon --
  if (adminCards.length) {
    console.log(`seeding ${adminCards.length} admin cards`);
    for (const card of adminCards) {
      await ensureAdminCard(card);
      if (!card.ownerEmail) continue;
      const owner = personFor(card.ownerEmail);
      const ownerPassword = passwordFor(card.ownerEmail);
      await ensureAccount(owner, 'venmo', ownerPassword);
      const venmoToken = await login('venmo', owner.email, ownerPassword);
      if (!venmoToken) throw new Error(`venmo login failed for ${owner.email}`);
      const venmoCardId = await ensureCardAttached('venmo', venmoToken, card);
      console.log(`  venmo card attached for ${owner.email}: id=${venmoCardId}`);
      // apps 含 amazon 的 fixture 人(或 oracle 且本轮有 amazonOrders)同时 attach amazon
      const wantAmazon = owner.apps.includes('amazon') || (owner.email === ORACLE.email && amazonOrders.length > 0);
      if (wantAmazon) {
        await ensureAccount(owner, 'amazon', ownerPassword);
        const amazonToken = await login('amazon', owner.email, ownerPassword);
        if (!amazonToken) throw new Error(`amazon login failed for ${owner.email}`);
        const amazonCardId = await ensureCardAttached('amazon', amazonToken, card);
        console.log(`  amazon card attached for ${owner.email}: id=${amazonCardId}`);
      }
    }
  }

  // -- venmoBalance:oracle 充值(需先有 attach 的 adminCard);at 回溯 --
  if (venmoBalances.length) {
    await ensureAccount(ORACLE, 'venmo', ORACLE_PASSWORD);
    const probeToken = await login('venmo', ORACLE.email, ORACLE_PASSWORD);
    if (!probeToken) throw new Error('oracle venmo login failed');
    const bal = await call('/venmo/balance', { headers: { Authorization: `Bearer ${probeToken}` } });
    const target = venmoBalances.reduce((sum, item) => sum + Number(item.amount || 0), 0);
    if (Number(bal?.venmo_balance || 0) >= target) {
      console.log(`  venmo balance exists: $${bal.venmo_balance} >= $${target}`);
    } else {
      const oracleCard = adminCards.find((c) => c.ownerEmail === ORACLE.email);
      for (const item of [...venmoBalances].sort(byAt)) {
        // token 在冻结窗口内签发、窗口内用完即弃 —— 解冻后即过期,不可复用。
        await timeShift(item.at, async () => {
          const token = await login('venmo', ORACLE.email, ORACLE_PASSWORD);
          if (!token) throw new Error('oracle venmo login failed (frozen)');
          const card = oracleCard ?? autoCardFor(ORACLE);
          if (!oracleCard) { await ensureAdminCard(card); }
          const cardId = await ensureCardAttached('venmo', token, card);
          await call('/venmo/balance', { method: 'POST', headers: jsonHeaders(token), body: JSON.stringify({ amount: item.amount, payment_card_id: cardId }) });
          console.log(`  venmo balance +$${item.amount}${item.at ? ` @ ${item.at}` : ''}`);
        });
      }
    }
  }

  // -- venmoTransactions:发送方登录真实转账;fixture 人发送方自动供卡充值 --
  if (venmoTransactions.length) {
    const parties = new Set(venmoTransactions.flatMap((t) => [t.fromEmail, t.toEmail]));
    for (const email of parties) {
      await ensureAccount(personFor(email), 'venmo', passwordFor(email));
    }
    for (const tx of [...venmoTransactions].sort(byAt)) {
      await timeShift(tx.at, async () => {
        const sender = personFor(tx.fromEmail);
        const token = await login('venmo', sender.email, passwordFor(sender.email));
        if (!token) throw new Error(`venmo login failed for ${sender.email}`);
        // 幂等:同描述+金额+对手方的交易已存在则跳过
        const existing = await call(`/venmo/transactions?query=${encodeURIComponent(tx.description)}&page_limit=20`, { headers: { Authorization: `Bearer ${token}` } }).catch(() => []) as Array<Record<string, any>>;
        if ((existing || []).some((t) => Number(t.amount) === Number(tx.amount) && String(t.receiver?.email || '') === tx.toEmail && String(t.description || '') === tx.description)) {
          console.log(`  venmo tx exists: ${tx.description}`);
          return;
        }
        await ensureVenmoFunds(sender, token, Number(tx.amount));
        await call('/venmo/transactions', {
          method: 'POST', headers: jsonHeaders(token),
          body: JSON.stringify({ receiver_email: tx.toEmail, amount: tx.amount, description: tx.description }),
        });
        console.log(`  venmo tx seeded: ${tx.fromEmail} -> ${tx.toEmail} $${tx.amount} @ ${tx.at}`);
      });
    }
  }

  // -- venmoIncomingRequests:fixture 人向 oracle 发付款请求 --
  if (venmoIncomingRequests.length) {
    await ensureAccount(ORACLE, 'venmo', ORACLE_PASSWORD);
    for (const email of new Set(venmoIncomingRequests.map((r) => r.fromEmail))) {
      await ensureAccount(personFor(email), 'venmo', passwordFor(email));
    }
    for (const req of [...venmoIncomingRequests].sort(byAt)) {
      await timeShift(req.at, async () => {
        const sender = personFor(req.fromEmail);
        const token = await login('venmo', sender.email, passwordFor(sender.email));
        if (!token) throw new Error(`venmo login failed for ${sender.email}`);
        const sentReqs = await call('/venmo/sent_payment_requests?page_limit=20', { headers: { Authorization: `Bearer ${token}` } }).catch(() => []) as Array<Record<string, any>>;
        if ((sentReqs || []).some((r) => Number(r.amount) === Number(req.amount) && String(r.receiver?.email || '') === ORACLE.email && String(r.description || '') === req.description)) {
          console.log(`  venmo request exists: ${req.description}`);
          return;
        }
        await call('/venmo/payment_requests', {
          method: 'POST', headers: jsonHeaders(token),
          body: JSON.stringify({ user_email: ORACLE.email, amount: req.amount, description: req.description }),
        });
        console.log(`  venmo request seeded: ${req.fromEmail} -> oracle $${req.amount} @ ${req.at}`);
      });
    }
  }

  // -- backdatedEmails:复用 emails 流程,包在 timeShift 里 --
  if (backdatedEmails.length) {
    // 账号先在窗口外建好;窗口内 seedOneEmail 只 login+发信。
    const seenSubjects = new Set<string>();
    for (const mail of backdatedEmails) {
      const recipients = (Array.isArray(mail?.to) ? mail.to : [mail?.to]).filter((x: unknown) => typeof x === 'string' && x) as string[];
      const replies = (mail.replies ?? []).filter((reply) => reply?.from && reply?.body);
      for (const address of [mail.from, ...recipients, ...replies.map((r) => r.from)]) {
        if (typeof address === 'string' && address) await ensureAccount(personFor(address), 'gmail', passwordFor(address));
      }
    }
    for (const mail of [...backdatedEmails].sort(byAt)) {
      await timeShift(mail.at, () => seedOneEmail(mail, seenSubjects, personFor, false));
    }
  }

  // -- sms:双方 phone 账号,发送方登录逐条发送 --
  if (smsMessages.length) {
    const phoneOwners = new Map<string, Person>([[ORACLE.phone, ORACLE]]);
    for (const person of people.values()) if (person.phone) phoneOwners.set(person.phone, person);
    const phones = new Set(smsMessages.flatMap((m) => [m.fromPhone, m.toPhone]));
    for (const phone of phones) {
      const owner = phoneOwners.get(phone);
      if (!owner) { console.warn(`  sms fixture phone ${phone} has no known owner (add to people[] with that phone)`); continue; }
      await ensureAccount(owner, 'phone', owner.email === ORACLE.email ? ORACLE_PASSWORD : password);
    }
    for (const msg of [...smsMessages].sort(byAt)) {
      const sender = phoneOwners.get(msg.fromPhone);
      const receiver = phoneOwners.get(msg.toPhone);
      if (!sender || !receiver) { console.warn(`  sms skipped (unknown phone): ${msg.fromPhone} -> ${msg.toPhone}`); continue; }
      await timeShift(msg.at, async () => {
        const token = await login('phone', sender.phone, sender.email === ORACLE.email ? ORACLE_PASSWORD : password);
        if (!token) throw new Error(`phone login failed for ${sender.phone}`);
        const existing = await call(`/phone/messages/text?phone_number=${encodeURIComponent(msg.toPhone)}&page_limit=20`, { headers: { Authorization: `Bearer ${token}` } }).catch(() => []) as Array<Record<string, any>>;
        if ((existing || []).some((m) => String(m.message || '') === msg.message)) { console.log(`  sms exists: ${msg.message.slice(0, 40)}`); return; }
        await call(`/phone/messages/text/${encodeURIComponent(msg.toPhone)}`, {
          method: 'POST', headers: jsonHeaders(token),
          body: JSON.stringify({ message: msg.message }),
        });
        console.log(`  sms seeded: ${msg.fromPhone} -> ${msg.toPhone} @ ${msg.at}`);
      });
    }
  }

  // -- todoistProjects:owner 建项目+任务,邀请协作者(invite_code 直接在响应里),受邀人接受 --
  if (todoistProjects.length) {
    for (const proj of todoistProjects) {
      const parties = [proj.ownerEmail, ...(proj.collaborators ?? [])];
      for (const email of parties) await ensureAccount(personFor(email), 'todoist', passwordFor(email));
    }
    for (const proj of [...todoistProjects].sort(byAt)) {
      await timeShift(proj.at, async () => {
        const ownerToken = await login('todoist', proj.ownerEmail, passwordFor(proj.ownerEmail));
        if (!ownerToken) throw new Error(`todoist login failed for ${proj.ownerEmail}`);
        // 幂等:同名项目已存在则复用其 id
        const existing = await call(`/todoist/projects?query=${encodeURIComponent(proj.name)}&page_limit=20`, { headers: { Authorization: `Bearer ${ownerToken}` } }).catch(() => []) as Array<Record<string, any>>;
        let projectId: number;
        const found = (existing || []).find((p) => String(p.name || '') === proj.name);
        if (found) {
          projectId = Number(found.project_id);
          console.log(`  todoist project exists: ${proj.name} (id=${projectId})`);
        } else {
          const created = await call('/todoist/projects', { method: 'POST', headers: jsonHeaders(ownerToken), body: JSON.stringify({ name: proj.name }) });
          projectId = Number(created?.project_id);
          console.log(`  todoist project seeded: ${proj.name} (id=${projectId}) @ ${proj.at}`);
        }
        const taskDump = JSON.stringify(await call(`/todoist/projects/${projectId}/tasks`, { headers: { Authorization: `Bearer ${ownerToken}` } }).catch(() => ({})));
        for (const task of proj.tasks ?? []) {
          if (taskDump.includes(JSON.stringify(task.content))) { console.log(`  todoist task exists: ${task.content}`); continue; }
          await call(`/todoist/projects/${projectId}/tasks`, {
            method: 'POST', headers: jsonHeaders(ownerToken),
            body: JSON.stringify({ title: task.content, ...(task.due ? { due_date: task.due } : {}) }),
          });
          console.log(`  todoist task seeded: ${task.content}`);
        }
        const collaboratorDump = JSON.stringify(found?.collaborators ?? []);
        for (const invitee of proj.collaborators ?? []) {
          if (collaboratorDump.includes(`"${invitee}"`)) { console.log(`  todoist collaborator exists: ${invitee}`); continue; }
          try {
            const inviteRes = await call(`/todoist/projects/${projectId}/invite`, { method: 'POST', headers: jsonHeaders(ownerToken), body: JSON.stringify({ email: invitee }) });
            const inviteCode = String(inviteRes?.invite_code || '');
            const inviteeToken = await login('todoist', invitee, passwordFor(invitee));
            if (!inviteeToken) throw new Error(`todoist login failed for ${invitee}`);
            await call(`/todoist/project_invites/${encodeURIComponent(inviteCode)}/accept`, { method: 'POST', headers: jsonHeaders(inviteeToken) });
            console.log(`  todoist collaborator joined: ${invitee}`);
          } catch (error) {
            if (String((error as Error).message).includes('already a collaborator')) console.log(`  todoist collaborator exists: ${invitee}`);
            else throw error;
          }
        }
      });
    }
  }

  // -- amazonOrders:oracle 的历史订单(地址+admin 卡+购物车+下单,全程回溯) --
  const deliveries: DeliveryRequest[] = [];
  if (amazonOrders.length) {
    await ensureAccount(ORACLE, 'amazon', ORACLE_PASSWORD);
    for (const order of [...amazonOrders].sort(byAt)) {
      await timeShift(order.at, async () => {
        const token = await login('amazon', ORACLE.email, ORACLE_PASSWORD);
        if (!token) throw new Error('oracle amazon login failed');
        // 幂等:同日已有订单则跳过(粒度粗但足够避免重复种子)
        const existing = await call('/amazon/orders?page_limit=20', { headers: { Authorization: `Bearer ${token}` } }).catch(() => []) as Array<Record<string, any>>;
        const day = String(order.at).slice(0, 10);
        const existingOrder=(existing || []).find((o) => String(o.created_at || '').startsWith(day));
        if (existingOrder) { if(order.delivered)deliveries.push({orderId:Number(existingOrder.order_id),deliveredAt:order.deliveredAt});console.log(`  amazon order exists for ${day}`); return; }
        // 地址
        const addresses = await call('/amazon/addresses', { headers: { Authorization: `Bearer ${token}` } }).catch(() => []) as Array<Record<string, any>>;
        const addrName = order.address.name || 'Home';
        let addressId = Number((addresses || []).find((a) => String(a.name || '') === addrName)?.address_id || 0);
        if (!addressId) {
          const created = await call('/amazon/addresses', {
            method: 'POST', headers: jsonHeaders(token),
            body: JSON.stringify({ name: addrName, street_address: order.address.streetAddress, city: order.address.city, state: order.address.state, country: order.address.country, zip_code: order.address.zipCode }),
          });
          addressId = Number(created?.address_id);
        }
        // 卡:优先本轮 oracle adminCard,否则自动卡
        const card = adminCards.find((c) => c.ownerEmail === ORACLE.email) ?? autoCardFor(ORACLE);
        await ensureAdminCard(card);
        const cardId = await ensureCardAttached('amazon', token, card);
        // 购物车:第一件清空旧车
        let added = 0;
        for (const [index, item] of order.items.entries()) {
          const results = await call(`/amazon/products?query=${encodeURIComponent(item.query)}&page_limit=5`, { headers: { Authorization: `Bearer ${token}` } }).catch(() => []) as Array<Record<string, any>>;
          const product = (results || [])[0];
          if (!product) { console.warn(`  amazon product not found for query: ${item.query}`); continue; }
          await call(`/amazon/cart/${product.product_id}`, {
            method: 'POST', headers: jsonHeaders(token),
            body: JSON.stringify({ quantity: item.qty ?? 1, clear_cart_first: index === 0 }),
          });
          added++;
        }
        if (!added) { console.warn(`  amazon order skipped (no items resolvable) @ ${order.at}`); return; }
        const placed = await call('/amazon/orders', { method: 'POST', headers: jsonHeaders(token), body: JSON.stringify({ payment_card_id: cardId, address_id: addressId }) });
        console.log(`  amazon order seeded: id=${placed?.order_id} (${added} items) @ ${order.at}`);
        if (order.delivered) deliveries.push({orderId:Number(placed?.order_id),deliveredAt:order.deliveredAt});
      });
    }
  }

  await deliverOrdersInManagedWorld(API, deliveries);
  console.log(`seeded ${people.size} people, ${notes.length} notes, ${fsFiles.length} files, ${emails.length} emails, ${contacts.length} contacts, likes=${spotifyLikeCount}, adminCards=${adminCards.length}, venmoBalance=${venmoBalances.length}, venmoTx=${venmoTransactions.length}, venmoReqs=${venmoIncomingRequests.length}, backdatedEmails=${backdatedEmails.length}, sms=${smsMessages.length}, todoistProjects=${todoistProjects.length}, amazonOrders=${amazonOrders.length}`);
}

main().then(() => { if (preparationWarnings.length) throw new Error(`Fixture preparation incomplete (${preparationWarnings.length} warning(s)); results must not be scored as a prepared world`); }).catch((e) => { console.error(e); process.exit(1); });
