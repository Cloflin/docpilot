/**
 * Credential shapes in the reader's question — RAG-SPEC 3.5.
 *
 * THIS IS THE ONLY POINT IN THE TURN WHERE A PASTED SECRET CAN STILL BE CAUGHT.
 *
 * The instruction envelope has carried a credential rule since 4.4 — "treat it
 * as compromised, do not quote the value" — and that rule is unreachable for the
 * question that actually triggers it. Two mechanisms sit in front of it. The
 * gate (3.4) settles "here is my key, where do I paste it?" before any model
 * call: the question names no documented subject, so L is near zero, and a
 * 64-character opaque token is the loudest thing in the embedding, so D is too.
 * The turn ends on `no-evidence` and the system message is never assembled. And
 * even on the questions that do pass, the rule fires far too late to matter —
 * by the time the model reads it the value has already gone to the embedder,
 * to the chat provider, into sessionStorage and into any feedback report.
 *
 * So the rule in prompt.js is READER-FACING SAFETY COPY for the case where a
 * secret rides along with an otherwise answerable question. This module is the
 * control: a synchronous, network-free test run in submit() before
 * `embedQuery`, before the chat transport, and before the turn is persisted.
 * A match settles the turn locally, and the value leaves the browser in no
 * direction at all — which is what makes the panel's copy able to say so.
 *
 * DETECTION IS BY SHAPE, AND SHAPE IS ALL IT CAN BE. There is no oracle for
 * "live credential"; the alternative to a shape test is no test. The error that
 * matters is therefore chosen deliberately: a false positive costs one extra
 * click on "answer without the key" and the question runs verbatim minus the
 * matched span, while a false negative is the failure this module exists to
 * prevent. The patterns lean loose in that direction.
 *
 * What is deliberately NOT matched: a bare UUID. `pluginId` is a UUID, the
 * envelope's rule names it, and it is also the shape of every template id,
 * message id and account id a reader might legitimately paste into a question.
 * Matching it would put a credential warning in front of ordinary questions
 * often enough to train the reader to click through it, which costs more than
 * the pluginId — not a secret on its own — is worth.
 */

/**
 * Ordered longest-context-first: `sk-or-v1-<64 hex>` must be consumed by the
 * `api-key` rule before `opaque-hex` can claim its tail, because redaction
 * rewrites the string between passes and a partial match would leave half a key
 * on screen.
 */
/** @type {Array<[string, RegExp]>} */
const PATTERNS: Array<[string, RegExp]> = [
  // OpenAI / OpenRouter / Anthropic and everything that copied the convention.
  ['api-key', /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{15,}/g],
  // GitHub's prefixed tokens: ghp_, gho_, ghu_, ghs_, ghr_.
  ['api-key', /\bgh[pousr]_[A-Za-z0-9]{20,}/g],
  // Slack, Stripe, SendGrid and the rest of the prefix-and-payload family.
  ['api-key', /\b(?:xox[abposr]-|rk_live_|sk_live_|SG\.)[A-Za-z0-9._-]{12,}/g],
  ['aws-key-id', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  // Three base64url segments. The leading eyJ is `{"` — a JSON header, so this
  // does not fire on arbitrary dotted identifiers.
  ['jwt', /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g],
  ['bearer', /\bBearer\s+[A-Za-z0-9._~+/-]{16,}={0,2}/gi],
  // A 32-hex-digit secret key, and every other hex digest used as one. Hex
  // cannot spell an English word — [g-z] is excluded — so a 32-run of [a-f0-9]
  // is a digest or an id, never prose. The known collision is a 40-character
  // git SHA; that costs a click.
  ['opaque-hex', /\b[a-fA-F0-9]{32,}\b/g],
]

/**
 * The placeholder VALUE the corpus uses, not the constant NAME.
 *
 * The distinction is the whole choice. `docs/extensions/getting-started` ships
 * `export const SECRET_KEY = 'YOUR_SECRET_KEY'` — `SECRET_KEY` is what the
 * binding is called and `YOUR_SECRET_KEY` is what stands in for the value. The
 * first mask this module used was the name, and qwen3:8b answered the redacted
 * question with `export const SECRET_KEY = 'SECRET_KEY'`: not a leak, but a
 * sample that tells the reader the value is literally the word.
 *
 * Measured on dd3ecb74, the value also retrieves better than the name — the
 * Russian question clears the gate at G = 0.377 rather than 0.325, against a
 * threshold of 0.30. `terms()` keeps the underscores, so both are single corpus
 * tokens and L is identical at 0.200; the whole difference is dense. A neutral
 * token like `[REDACTED]` would have cost both channels: it appears nowhere in
 * the corpus, and the L it contributes is zero.
 */
export const MASK = 'YOUR_SECRET_KEY'

/**
 * Every credential-shaped span, with its kind. Order and offsets are of the
 * ORIGINAL string, so this is safe to use for reporting; use redactSecrets for
 * rewriting, which handles the overlap between the prefixed and the hex rules.
 */
export function findSecrets(text) {
  const s = String(text || '')
  const hits = []
  const taken = []
  for (const [kind, re] of PATTERNS) {
    re.lastIndex = 0
    for (const m of s.matchAll(re)) {
      const start = m.index
      const end = start + m[0].length
      // A later, looser rule may not re-report a span an earlier rule owns.
      if (taken.some(([a, b]) => start < b && end > a)) continue
      taken.push([start, end])
      hits.push({ kind, start, end, length: m[0].length })
    }
  }
  return hits.sort((a, b) => a.start - b.start)
}

export const hasSecret = (text) => findSecrets(text).length > 0

/**
 * The question with every matched span replaced by MASK.
 *
 * This one string is used for all three purposes — what is shown back to the
 * reader, what is written to sessionStorage, and what is sent if they ask for
 * the answer anyway — so there is no path on which the original survives.
 */
export function redactSecrets(text) {
  const s = String(text || '')
  const hits = findSecrets(s)
  if (!hits.length) return { clean: s, kinds: [], count: 0 }
  let out = ''
  let at = 0
  for (const h of hits) {
    out += s.slice(at, h.start) + MASK
    at = h.end
  }
  out += s.slice(at)
  return { clean: out, kinds: [...new Set(hits.map((h) => h.kind))], count: hits.length }
}

/**
 * The warning is written by the HOST, not by the model — the whole point is
 * that no model call happens — so the language cannot come from
 * `languageDirective`. It comes from a table keyed by the same detector
 * prompt.js uses, and falls back to English on the languages that detector does
 * not name.
 *
 * Three strings, not a paragraph: this text is read by someone who has just
 * been told they made a mistake, and every sentence past the third is one they
 * will not finish.
 */
const COPY = {
  en: {
    lead: "Don't paste keys or tokens here.",
    body: 'This one was not sent anywhere — the question stopped in the browser and the value is not kept in the thread. If it has already been pasted somewhere else, replace it wherever it was issued.',
    action: 'Answer the question without the key',
  },
  ru: {
    lead: 'Не вставляйте сюда ключи и токены.',
    body: 'Этот ключ никуда не отправлен — вопрос остановился в браузере, значение не сохранено в переписке. Если вы уже вставляли его где-то ещё, замените его там, где он был выдан.',
    action: 'Ответить на вопрос без ключа',
  },
  uk: {
    lead: 'Не вставляйте сюди ключі та токени.',
    body: 'Цей ключ нікуди не надіслано — запитання зупинилося в браузері, значення не збережено в переписці. Якщо ви вже вставляли його десь інде, замініть його там, де його було видано.',
    action: 'Відповісти на запитання без ключа',
  },
  es: {
    lead: 'No pegue aquí claves ni tokens.',
    body: 'Esta clave no se ha enviado a ninguna parte: la pregunta se detuvo en el navegador y el valor no se guarda en la conversación. Si ya la ha pegado en otro sitio, sustitúyala donde se emitió.',
    action: 'Responder a la pregunta sin la clave',
  },
  pt: {
    lead: 'Não cole chaves nem tokens aqui.',
    body: 'Esta chave não foi enviada para lugar nenhum — a pergunta parou no navegador e o valor não fica guardado na conversa. Se você já a colou em outro lugar, substitua-a onde ela foi emitida.',
    action: 'Responder à pergunta sem a chave',
  },
  fr: {
    lead: 'Ne collez pas de clés ni de jetons ici.',
    body: "Cette clé n'a été envoyée nulle part : la question s'est arrêtée dans le navigateur et la valeur n'est pas conservée dans la conversation. Si vous l'avez déjà collée ailleurs, remplacez-la là où elle a été émise.",
    action: 'Répondre à la question sans la clé',
  },
  de: {
    lead: 'Fügen Sie hier keine Schlüssel oder Tokens ein.',
    body: 'Dieser Schlüssel wurde nirgendwohin gesendet — die Frage ist im Browser geblieben und der Wert wird nicht im Verlauf gespeichert. Falls Sie ihn bereits anderswo eingefügt haben, ersetzen Sie ihn dort, wo er ausgestellt wurde.',
    action: 'Die Frage ohne den Schlüssel beantworten',
  },
  it: {
    lead: 'Non incollare qui chiavi o token.',
    body: "Questa chiave non è stata inviata da nessuna parte: la domanda si è fermata nel browser e il valore non viene conservato nella conversazione. Se è già stata incollata altrove, sostituirla dove è stata emessa.",
    action: 'Rispondere alla domanda senza la chiave',
  },
  pl: {
    lead: 'Nie wklejaj tutaj kluczy ani tokenów.',
    body: 'Ten klucz nie został nigdzie wysłany — pytanie zatrzymało się w przeglądarce, a wartość nie jest zapisywana w rozmowie. Jeśli był już wklejony gdzie indziej, zastąp go tam, gdzie został wydany.',
    action: 'Odpowiedz na pytanie bez klucza',
  },
  tr: {
    lead: 'Buraya anahtar veya token yapıştırmayın.',
    body: 'Bu anahtar hiçbir yere gönderilmedi — soru tarayıcıda kaldı ve değer sohbette saklanmıyor. Daha önce başka bir yere yapıştırdıysanız, anahtarı verildiği yerden değiştirin.',
    action: 'Soruyu anahtar olmadan yanıtla',
  },
  ja: {
    lead: 'ここにキーやトークンを貼り付けないでください。',
    body: 'このキーはどこにも送信されていません。質問はブラウザーで止まり、値は履歴に保存されていません。すでに他の場所に貼り付けている場合は、発行元で再発行してください。',
    action: 'キーなしで質問に回答する',
  },
  ko: {
    lead: '여기에 키나 토큰을 붙여넣지 마세요.',
    body: '이 키는 어디에도 전송되지 않았습니다. 질문은 브라우저에서 멈췄고 값은 대화에 저장되지 않습니다. 이미 다른 곳에 붙여넣었다면 발급받은 곳에서 교체하세요.',
    action: '키 없이 질문에 답변하기',
  },
  zh: {
    lead: '请不要在此处粘贴密钥或令牌。',
    body: '该密钥没有发送到任何地方——问题止步于浏览器，其值不会保存在会话记录中。如果你已经把它粘贴到别处，请在签发它的地方替换它。',
    action: '不带密钥回答这个问题',
  },
  ar: {
    lead: 'لا تلصق المفاتيح أو الرموز هنا.',
    body: 'لم يُرسل هذا المفتاح إلى أي مكان — توقّف السؤال داخل المتصفّح ولم تُحفظ القيمة في المحادثة. إذا سبق أن لصقته في مكان آخر، فاستبدله من الجهة التي أصدرته.',
    action: 'الإجابة عن السؤال بدون المفتاح',
  },
  he: {
    lead: 'אין להדביק כאן מפתחות או טוקנים.',
    body: 'המפתח הזה לא נשלח לשום מקום — השאלה נעצרה בדפדפן והערך אינו נשמר בשיחה. אם כבר הדבקתם אותו במקום אחר, החליפו אותו במקום שבו הונפק.',
    action: 'לענות על השאלה בלי המפתח',
  },
  hi: {
    lead: 'यहाँ कुंजियाँ या टोकन न चिपकाएँ।',
    body: 'यह कुंजी कहीं नहीं भेजी गई — प्रश्न ब्राउज़र में ही रुक गया और मान बातचीत में सहेजा नहीं जाता। अगर आपने इसे पहले कहीं और चिपकाया है, तो जहाँ से यह जारी हुई थी वहीं इसे बदल दें।',
    action: 'कुंजी के बिना प्रश्न का उत्तर दें',
  },
  el: {
    lead: 'Μην επικολλάτε κλειδιά ή διακριτικά εδώ.',
    body: 'Αυτό το κλειδί δεν στάλθηκε πουθενά — η ερώτηση σταμάτησε στο πρόγραμμα περιήγησης και η τιμή δεν αποθηκεύεται στη συνομιλία. Αν το έχετε ήδη επικολλήσει κάπου αλλού, αντικαταστήστε το εκεί όπου εκδόθηκε.',
    action: 'Απάντηση στην ερώτηση χωρίς το κλειδί',
  },
  th: {
    lead: 'อย่าวางคีย์หรือโทเคนที่นี่',
    body: 'คีย์นี้ไม่ได้ถูกส่งไปที่ใด — คำถามหยุดอยู่ในเบราว์เซอร์ และค่าไม่ได้ถูกเก็บไว้ในบทสนทนา หากคุณเคยวางคีย์นี้ไว้ที่อื่นแล้ว ให้เปลี่ยนคีย์จากที่ที่ออกคีย์ให้คุณ',
    action: 'ตอบคำถามโดยไม่ใช้คีย์',
  },
}

export const CREDENTIAL_LANGUAGES = Object.keys(COPY)

/** The shipped table, for the i18n layer to merge an override on top of. */
export const CREDENTIAL_COPY = COPY

/**
 * @param {string} locale a language SUBTAG — `ru`, not `Russian`.
 *
 * The key space moved from the detector's own names to BCP 47 subtags so that a
 * site with a `ru` VitePress locale can write one override block covering both
 * the panel chrome and this reply. `localeOf()` in prompt.js is the bridge.
 */
export function credentialCopy(locale) {
  return COPY[locale] || COPY.en
}
