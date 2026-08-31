/**
 * Social openers — a greeting is not a failed question.
 *
 * WHY THIS EXISTS. The gate (RAG-SPEC 3.4) runs before any model call and passes
 * only what the documentation can support. "Привет" carries no documented
 * subject, so D and L are both ~0, the turn ends on `no-evidence`, and the panel
 * answers "I couldn't find this in the docs." That verdict is CORRECT and the
 * outcome is wrong in the most expensive place there is: a greeting is the most
 * common first thing anyone types, so the assistant's first act is to tell the
 * reader it failed. Measured on the shipped panel — it reads as a broken
 * feature, not as a scope boundary, and the reader leaves.
 *
 * This is the same shape as credentials.js and sits beside it for the same
 * reason: the gate's answer is right, so the fix cannot be a threshold. It has
 * to be a class of input recognised BEFORE the gate and settled locally.
 *
 * NO MODEL CALL. The reply is a template, not a generation. Three reasons, in
 * order of weight: a model handed no evidence is exactly the configuration that
 * invents product behaviour, and "hello" is not worth that risk; the copy is
 * reader-facing UI and belongs in the repository where it can be reviewed in a
 * diff; and a greeting costs zero tokens instead of a round trip. `temperature`
 * is therefore not a lever here and never will be — nothing is sampled.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not intercept a greeting attached to
 * a real question. "Привет, как подключить редактор?" carries a subject, and
 * answering it with a wave would be worse than the refusal this module exists to
 * remove. Only an input that is social AND NOTHING ELSE is claimed; everything
 * else falls through to the gate untouched.
 */

/**
 * The patterns are anchored to the WHOLE input, which is what keeps this
 * conservative. A question that merely opens with a greeting fails every one of
 * them and takes the normal path.
 *
 * Ordered by specificity: `identity` before `greeting`, because "привет, кто ты"
 * is both and the identity answer is the more useful of the two.
 */
/** @type {Array<[string, RegExp]>} */
const PATTERNS: Array<[string, RegExp]> = [
  [
    'identity',
    /^(?:hi|hello|hey|привет|здравствуйте)?[\s,!.]*(?:who\s+are\s+you|what\s+are\s+you|what\s+can\s+you\s+do|who\s+is\s+this|what\s+is\s+this|кто\s+ты|кто\s+вы|что\s+ты(?:\s+умеешь|\s+можешь)?|что\s+вы\s+умеете|ты\s+кто|чем\s+ты\s+можешь\s+помочь|что\s+это(?:\s+такое)?|хто\s+ти|quién\s+eres|qué\s+eres|quem\s+é\s+você|qui\s+es-tu|wer\s+bist\s+du|chi\s+sei)[\s?!.]*$/iu,
  ],
  [
    'thanks',
    /^(?:thanks|thank\s+you|thx|ty|cheers|спасибо|спс|благодарю|дякую|gracias|obrigad[oa]|merci|danke|grazie|dziękuję|teşekkürler|ありがとう|감사합니다|谢谢|شكرا|תודה|धन्यवाद|ευχαριστώ|ขอบคุณ)[\s,!.]*(?:you|большое|огромное|very\s+much|a\s+lot)?[\s!.]*$/iu,
  ],
  [
    'farewell',
    /^(?:bye|goodbye|see\s+you|later|пока|до\s+свидания|прощай|бувай|adiós|tchau|au\s+revoir|tschüss|ciao|do\s+widzenia|görüşürüz|さようなら|안녕히|再见|مع\s+السلامة|להתראות|अलविदा|αντίο|ลาก่อน)[\s,!.]*$/iu,
  ],
  [
    'greeting',
    /^(?:hi|hii+|hey+|hello+|yo|good\s+(?:morning|afternoon|evening|day)|greetings|привет+|приветствую|здравствуй(?:те)?|здорово|добрый\s+(?:день|вечер)|доброе\s+утро|доброго\s+дня|салют|хай|привіт|вітаю|hola|buen(?:os|as)\s+(?:días|tardes|noches)|olá|oi|bom\s+dia|boa\s+(?:tarde|noite)|bonjour|salut|bonsoir|hallo|guten\s+(?:tag|morgen|abend)|servus|ciao|buongiorno|cześć|dzień\s+dobry|witam|merhaba|selam|こんにちは|おはよう|안녕하세요|你好|您好|مرحبا|السلام\s+عليكم|שלום|नमस्ते|γεια(?:\s+σου|\s+σας)?|สวัสดี)[\s,!.]*(?:there|all|everyone|team|bot|ai|ассистент|бот)?[\s!.]*$/iu,
  ],
  // "как дела" and its family: sociable, subject-free, and otherwise refused.
  [
    'greeting',
    /^(?:how\s+are\s+you(?:\s+doing)?|how'?s\s+it\s+going|what'?s\s+up|как\s+дела|как\s+ты|как\s+жизнь|как\s+оно|як\s+справи|¿?cómo\s+estás\??|como\s+vai|ça\s+va|wie\s+geht'?s|come\s+stai)[\s?!.]*$/iu,
  ],
]

/**
 * `null` for everything that is not purely social — the common case, and the one
 * that must stay cheap: five anchored regexes on a trimmed string, no allocation
 * beyond the trim, run in submit() before the embedder is contacted.
 *
 * `hasQuote` is the other half of "social AND NOTHING ELSE". A reader who
 * selects a passage and asks "что это?" has said something else — the passage —
 * and the identity pattern above matches that phrase exactly. Without this the
 * quoting feature answers "I'm the assistant for this documentation" to a
 * question about the text under the cursor.
 *
 * @param {string} text
 * @param {{ hasQuote?: boolean }} [opts]
 */
export function detectSocial(text: string, { hasQuote = false }: { hasQuote?: boolean } = {}) {
  if (hasQuote) return null
  const s = String(text || '').trim()
  if (!s || s.length > 64) return null // a long input is a question, whatever it opens with
  for (const [kind, re] of PATTERNS) if (re.test(s)) return { kind }
  return null
}

/**
 * The copy. `lead` names what this is, `body` says what it covers, `invite` asks
 * the reader for their question — the panel renders its suggestion rows directly
 * under it, so the invitation always has something to act on.
 *
 * Written per language rather than machine-translated at runtime for the same
 * reason credentials.js is: this is reader-facing product copy and it belongs in
 * a diff. Keyed by language SUBTAG, the same key space VitePress `locales` uses,
 * so a site that already declares `ru` writes one override block and covers both
 * the panel chrome and this reply. An unlisted subtag falls back to `en`.
 *
 * DELIBERATELY BRAND-FREE, and deliberately not interpolating `{product}` into
 * the shipped `lead`. "I answer questions about {product}" only reads correctly
 * in English: Russian and German want a genitive, Turkish wants a suffix, and a
 * neutral default substituted into a case-marked slot produces broken grammar in
 * half the table. A project that wants its product named here overrides
 * `reply.social.<kind>.lead` per locale, where the author writes the whole
 * sentence and `{product}` is available if they want it.
 */
const COPY = {
  en: {
    greeting: {
      lead: 'Hi! I answer questions about this documentation.',
      body: 'Anything these pages cover — setup, configuration, the APIs, whatever is written down. I answer from the pages themselves and link the one each answer came from.',
      invite: 'What are you building? Pick one below, or just describe what you are stuck on.',
    },
    identity: {
      lead: "I'm the assistant for this documentation.",
      body: 'I search these docs and answer from them, always with a link to the page an answer came from. I do not guess: when the documentation does not cover something, I say so instead of inventing it.',
      invite: 'What would you like to know?',
    },
    thanks: { lead: 'Glad it helped.', body: '', invite: 'Anything else you want to look up?' },
    farewell: { lead: 'Goodbye — come back any time.', body: '', invite: '' },
  },
  ru: {
    greeting: {
      lead: 'Привет! Я отвечаю на вопросы по этой документации.',
      body: 'Всё, что здесь описано — установка, настройка, API, что угодно из написанного. Я отвечаю по самим страницам и даю ссылку на ту, откуда взят ответ.',
      invite: 'Что настраиваете? Выберите вопрос ниже или просто опишите, на чём застряли.',
    },
    identity: {
      lead: 'Я помощник по этой документации.',
      body: 'Я ищу по этой документации и отвечаю только по ней, всегда со ссылкой на страницу-источник. Не угадываю: если в документации чего-то нет, я так и скажу, а не придумаю.',
      invite: 'Что хотите узнать?',
    },
    thanks: { lead: 'Рад помочь.', body: '', invite: 'Посмотрим что-нибудь ещё?' },
    farewell: { lead: 'До встречи — возвращайтесь в любое время.', body: '', invite: '' },
  },
  uk: {
    greeting: {
      lead: 'Привіт! Я відповідаю на запитання за цією документацією.',
      body: 'Усе, що тут описано — встановлення, налаштування, API, будь-що з написаного. Я відповідаю за самими сторінками і даю посилання на ту, звідки взято відповідь.',
      invite: 'Що налаштовуєте? Оберіть питання нижче або опишіть, на чому зупинилися.',
    },
    identity: {
      lead: 'Я помічник із цієї документації.',
      body: 'Я шукаю в цій документації та відповідаю лише за нею, завжди з посиланням на сторінку-джерело. Якщо чогось у документації немає, я так і скажу.',
      invite: 'Що б ви хотіли дізнатися?',
    },
    thanks: { lead: 'Радий допомогти.', body: '', invite: 'Пошукаємо ще щось?' },
    farewell: { lead: 'До зустрічі — повертайтеся будь-коли.', body: '', invite: '' },
  },
  es: {
    greeting: {
      lead: '¡Hola! Respondo preguntas sobre esta documentación.',
      body: 'Todo lo que cubren estas páginas: instalación, configuración, las API, lo que esté escrito. Respondo a partir de las páginas mismas y enlazo aquella de la que viene cada respuesta.',
      invite: '¿Qué estás construyendo? Elige una pregunta o cuéntame dónde te has atascado.',
    },
    identity: {
      lead: 'Soy el asistente de esta documentación.',
      body: 'Busco en esta documentación y respondo solo a partir de ella, siempre con un enlace a la página de origen. Si algo no está documentado, lo digo en lugar de inventarlo.',
      invite: '¿Qué te gustaría saber?',
    },
    thanks: { lead: 'Me alegro de haber ayudado.', body: '', invite: '¿Buscamos algo más?' },
    farewell: { lead: 'Hasta luego, vuelve cuando quieras.', body: '', invite: '' },
  },
  pt: {
    greeting: {
      lead: 'Olá! Respondo a perguntas sobre esta documentação.',
      body: 'Tudo o que estas páginas cobrem: instalação, configuração, as APIs, o que estiver escrito. Respondo a partir das próprias páginas e ligo para aquela de onde veio cada resposta.',
      invite: 'O que está a construir? Escolha uma pergunta abaixo ou descreva onde ficou preso.',
    },
    identity: {
      lead: 'Sou o assistente desta documentação.',
      body: 'Pesquiso nesta documentação e respondo apenas com base nela, sempre com o link da página de origem. Se algo não estiver documentado, eu digo em vez de inventar.',
      invite: 'O que gostaria de saber?',
    },
    thanks: {
      lead: 'Fico contente por ter ajudado.',
      body: '',
      invite: 'Procuramos mais alguma coisa?',
    },
    farewell: { lead: 'Até breve — volte quando quiser.', body: '', invite: '' },
  },
  fr: {
    greeting: {
      lead: 'Bonjour ! Je réponds aux questions sur cette documentation.',
      body: 'Tout ce que ces pages couvrent : installation, configuration, les API, ce qui y est écrit. Je réponds à partir des pages elles-mêmes et je renvoie vers celle dont vient chaque réponse.',
      invite: 'Que construisez-vous ? Choisissez une question ci-dessous, ou dites-moi où vous bloquez.',
    },
    identity: {
      lead: 'Je suis l’assistant de cette documentation.',
      body: 'Je cherche dans cette documentation et je réponds uniquement à partir d’elle, toujours avec un lien vers la page source. Si quelque chose n’y figure pas, je le dis plutôt que de l’inventer.',
      invite: 'Que souhaitez-vous savoir ?',
    },
    thanks: { lead: 'Ravi d’avoir aidé.', body: '', invite: 'On cherche autre chose ?' },
    farewell: { lead: 'À bientôt — revenez quand vous voulez.', body: '', invite: '' },
  },
  de: {
    greeting: {
      lead: 'Hallo! Ich beantworte Fragen zu dieser Dokumentation.',
      body: 'Alles, was hier steht — Einrichtung, Konfiguration, die APIs, was auch immer dokumentiert ist. Ich antworte aus den Seiten selbst und verlinke die, aus der die Antwort stammt.',
      invite: 'Woran arbeiten Sie? Wählen Sie unten eine Frage oder beschreiben Sie, wo es hakt.',
    },
    identity: {
      lead: 'Ich bin der Assistent für diese Dokumentation.',
      body: 'Ich durchsuche diese Dokumentation und antworte ausschließlich aus ihr, immer mit Link zur Quellseite. Was nicht dokumentiert ist, sage ich — erfinden werde ich es nicht.',
      invite: 'Was möchten Sie wissen?',
    },
    thanks: { lead: 'Gern geschehen.', body: '', invite: 'Sollen wir noch etwas nachschlagen?' },
    farewell: { lead: 'Auf Wiedersehen — kommen Sie jederzeit wieder.', body: '', invite: '' },
  },
  it: {
    greeting: {
      lead: 'Ciao! Rispondo a domande su questa documentazione.',
      body: 'Tutto ciò che queste pagine coprono: installazione, configurazione, le API, quello che è scritto. Rispondo dalle pagine stesse e collego quella da cui viene ogni risposta.',
      invite: 'Che cosa stai costruendo? Scegli una domanda qui sotto o raccontami dove ti sei bloccato.',
    },
    identity: {
      lead: 'Sono l’assistente di questa documentazione.',
      body: 'Cerco in questa documentazione e rispondo solo in base a essa, sempre con il link alla pagina di origine. Se qualcosa non è documentato lo dico, non lo invento.',
      invite: 'Che cosa vorresti sapere?',
    },
    thanks: { lead: 'Felice di essere stato utile.', body: '', invite: 'Cerchiamo altro?' },
    farewell: { lead: 'A presto — torna quando vuoi.', body: '', invite: '' },
  },
  pl: {
    greeting: {
      lead: 'Cześć! Odpowiadam na pytania o tę dokumentację.',
      body: 'Wszystko, co obejmują te strony — instalacja, konfiguracja, API, cokolwiek jest opisane. Odpowiadam na podstawie samych stron i podaję link do tej, z której pochodzi odpowiedź.',
      invite: 'Co budujesz? Wybierz pytanie poniżej albo opisz, na czym utknąłeś.',
    },
    identity: {
      lead: 'Jestem asystentem tej dokumentacji.',
      body: 'Przeszukuję tę dokumentację i odpowiadam wyłącznie na jej podstawie, zawsze z linkiem do strony źródłowej. Czego nie ma w dokumentacji, tego nie wymyślam — mówię wprost.',
      invite: 'Czego chciałbyś się dowiedzieć?',
    },
    thanks: { lead: 'Cieszę się, że pomogło.', body: '', invite: 'Sprawdzimy coś jeszcze?' },
    farewell: { lead: 'Do zobaczenia — wracaj, kiedy chcesz.', body: '', invite: '' },
  },
  tr: {
    greeting: {
      lead: 'Merhaba! Bu belgelerle ilgili soruları yanıtlıyorum.',
      body: 'Bu sayfaların kapsadığı her şey: kurulum, yapılandırma, API’ler, yazılı olan ne varsa. Sayfaların kendisinden yanıtlar ve yanıtın geldiği sayfaya bağlantı veririm.',
      invite: 'Ne geliştiriyorsunuz? Aşağıdan bir soru seçin ya da nerede takıldığınızı anlatın.',
    },
    identity: {
      lead: 'Bu belgelerin asistanıyım.',
      body: 'Bu belgelerde arama yapar ve yalnızca onlara dayanarak, her zaman kaynak sayfa bağlantısıyla yanıt veririm. Belgelerde olmayan bir şeyi uydurmam, açıkça söylerim.',
      invite: 'Ne öğrenmek istersiniz?',
    },
    thanks: {
      lead: 'Yardımcı olabildiğime sevindim.',
      body: '',
      invite: 'Başka bir şeye bakalım mı?',
    },
    farewell: { lead: 'Görüşmek üzere — istediğiniz zaman dönün.', body: '', invite: '' },
  },
  ja: {
    greeting: {
      lead: 'こんにちは。このドキュメントについての質問にお答えします。',
      body: 'このページ群に書かれていることなら何でも — 導入、設定、各種 API、記載されているものすべて。ページそのものからお答えし、出典ページへのリンクを添えます。',
      invite: '何を作っていますか。下の質問を選ぶか、つまずいている点をお書きください。',
    },
    identity: {
      lead: 'このドキュメントのアシスタントです。',
      body: 'このドキュメントを検索し、その内容だけに基づいて、必ず出典ページのリンクとともに回答します。書かれていないことは推測せず、その旨をお伝えします。',
      invite: '何を知りたいですか。',
    },
    thanks: { lead: 'お役に立てて何よりです。', body: '', invite: 'ほかにお調べしますか。' },
    farewell: { lead: 'またいつでもどうぞ。', body: '', invite: '' },
  },
  ko: {
    greeting: {
      lead: '안녕하세요! 이 문서에 대한 질문에 답해 드립니다.',
      body: '이 페이지들이 다루는 모든 것 — 설치, 설정, API, 문서에 적힌 무엇이든. 페이지 자체를 근거로 답하고 답이 나온 페이지 링크를 함께 드립니다.',
      invite: '무엇을 만들고 계신가요? 아래 질문을 고르거나 막힌 부분을 알려주세요.',
    },
    identity: {
      lead: '이 문서의 도우미입니다.',
      body: '이 문서를 검색해 그 내용만으로, 항상 출처 페이지 링크와 함께 답변합니다. 문서에 없는 내용은 지어내지 않고 없다고 말씀드립니다.',
      invite: '무엇이 궁금하신가요?',
    },
    thanks: { lead: '도움이 되었다니 다행입니다.', body: '', invite: '더 찾아볼 것이 있을까요?' },
    farewell: { lead: '안녕히 가세요 — 언제든 다시 오세요.', body: '', invite: '' },
  },
  zh: {
    greeting: {
      lead: '你好！我回答关于这套文档的问题。',
      body: '这些页面涵盖的一切——安装、配置、各类 API，凡是写下来的都算。我依据页面本身作答，并附上出处页面的链接。',
      invite: '你在做什么？可以从下面选一个问题，或者直接说说卡在哪里。',
    },
    identity: {
      lead: '我是这套文档的助手。',
      body: '我只检索这套文档并据此作答，每个回答都附出处页面链接。文档里没有的内容，我会直说，而不会编造。',
      invite: '你想了解什么？',
    },
    thanks: { lead: '很高兴帮上忙。', body: '', invite: '还要查点别的吗？' },
    farewell: { lead: '再见，随时回来。', body: '', invite: '' },
  },
  ar: {
    greeting: {
      lead: 'مرحبًا! أجيب عن الأسئلة المتعلقة بهذا التوثيق.',
      body: 'كل ما تغطّيه هذه الصفحات: التهيئة، والإعداد، وواجهات البرمجة، وكل ما هو مكتوب. أجيب من الصفحات نفسها وأرفق رابط الصفحة التي جاءت منها الإجابة.',
      invite: 'ما الذي تبنيه؟ اختر سؤالًا بالأسفل أو صِف ما تعثّرت فيه.',
    },
    identity: {
      lead: 'أنا مساعد هذا التوثيق.',
      body: 'أبحث في هذا التوثيق وأجيب منه وحده، مع رابط الصفحة المصدر دائمًا. وما لا يذكره التوثيق أقوله صراحةً ولا أختلقه.',
      invite: 'ما الذي تودّ معرفته؟',
    },
    thanks: { lead: 'سعيد بأن ذلك أفادك.', body: '', invite: 'هل نبحث عن شيء آخر؟' },
    farewell: { lead: 'إلى اللقاء — عُد في أي وقت.', body: '', invite: '' },
  },
  he: {
    greeting: {
      lead: 'שלום! אני עונה על שאלות בנוגע לתיעוד הזה.',
      body: 'כל מה שהעמודים האלה מכסים — התקנה, הגדרות, ממשקי API, כל מה שכתוב. אני עונה מתוך העמודים עצמם ומקשר לעמוד שממנו הגיעה התשובה.',
      invite: 'מה אתם בונים? בחרו שאלה למטה או תארו איפה נתקעתם.',
    },
    identity: {
      lead: 'אני העוזר של התיעוד הזה.',
      body: 'אני מחפש בתיעוד הזה ועונה רק ממנו, תמיד עם קישור לעמוד המקור. מה שלא מתועד — אומר זאת ולא ממציא.',
      invite: 'מה תרצו לדעת?',
    },
    thanks: { lead: 'שמח שעזרתי.', body: '', invite: 'נחפש עוד משהו?' },
    farewell: { lead: 'להתראות — חזרו מתי שתרצו.', body: '', invite: '' },
  },
  hi: {
    greeting: {
      lead: 'नमस्ते! मैं इन दस्तावेज़ों से जुड़े सवालों के जवाब देता हूँ।',
      body: 'जो कुछ भी इन पृष्ठों में है — सेटअप, कॉन्फ़िगरेशन, API, जो भी लिखा गया है। मैं पृष्ठों के आधार पर उत्तर देता हूँ और स्रोत पृष्ठ का लिंक भी देता हूँ।',
      invite: 'आप क्या बना रहे हैं? नीचे से कोई सवाल चुनें या बताएँ कि कहाँ अटके हैं।',
    },
    identity: {
      lead: 'मैं इन दस्तावेज़ों का सहायक हूँ।',
      body: 'मैं इन दस्तावेज़ों में खोजता हूँ और केवल उन्हीं के आधार पर, हमेशा स्रोत पृष्ठ के लिंक के साथ उत्तर देता हूँ। जो दस्तावेज़ों में नहीं है, उसे गढ़ता नहीं — बता देता हूँ।',
      invite: 'आप क्या जानना चाहेंगे?',
    },
    thanks: { lead: 'मदद कर पाकर अच्छा लगा।', body: '', invite: 'कुछ और देखें?' },
    farewell: { lead: 'अलविदा — कभी भी लौट आइए।', body: '', invite: '' },
  },
  el: {
    greeting: {
      lead: 'Γεια σας! Απαντώ σε ερωτήσεις για αυτή την τεκμηρίωση.',
      body: 'Ό,τι καλύπτουν αυτές οι σελίδες: εγκατάσταση, ρυθμίσεις, τα API, ό,τι είναι γραμμένο. Απαντώ από τις ίδιες τις σελίδες και δίνω σύνδεσμο σε εκείνη από την οποία προήλθε η απάντηση.',
      invite: 'Τι φτιάχνετε; Διαλέξτε μια ερώτηση παρακάτω ή πείτε μου πού κολλήσατε.',
    },
    identity: {
      lead: 'Είμαι ο βοηθός αυτής της τεκμηρίωσης.',
      body: 'Ψάχνω σε αυτή την τεκμηρίωση και απαντώ μόνο από αυτήν, πάντα με σύνδεσμο στη σελίδα προέλευσης. Ό,τι δεν τεκμηριώνεται, το λέω αντί να το επινοήσω.',
      invite: 'Τι θα θέλατε να μάθετε;',
    },
    thanks: { lead: 'Χαίρομαι που βοήθησα.', body: '', invite: 'Να ψάξουμε κάτι ακόμη;' },
    farewell: { lead: 'Αντίο — επιστρέψτε όποτε θέλετε.', body: '', invite: '' },
  },
  th: {
    greeting: {
      lead: 'สวัสดี! ผมตอบคำถามเกี่ยวกับเอกสารชุดนี้',
      body: 'ทุกอย่างที่หน้าเหล่านี้ครอบคลุม — การติดตั้ง การตั้งค่า API และสิ่งใดก็ตามที่เขียนไว้ ผมตอบจากตัวหน้าเอง พร้อมลิงก์ไปยังหน้าที่คำตอบมาจาก',
      invite: 'คุณกำลังสร้างอะไรอยู่ เลือกคำถามด้านล่าง หรือเล่าว่าติดตรงไหน',
    },
    identity: {
      lead: 'ผมเป็นผู้ช่วยของเอกสารชุดนี้',
      body: 'ผมค้นจากเอกสารชุดนี้และตอบจากเนื้อหาในนั้นเท่านั้น พร้อมลิงก์หน้าต้นทางเสมอ สิ่งใดที่เอกสารไม่ได้ระบุ ผมจะบอกตรง ๆ ไม่แต่งขึ้นเอง',
      invite: 'อยากทราบเรื่องอะไรครับ',
    },
    thanks: { lead: 'ยินดีที่ได้ช่วยครับ', body: '', invite: 'ค้นเรื่องอื่นอีกไหม' },
    farewell: { lead: 'แล้วพบกันใหม่ — กลับมาได้ทุกเมื่อ', body: '', invite: '' },
  },
}

export const SOCIAL_LANGUAGES = Object.keys(COPY)

/** The shipped table, for the i18n layer to merge an override on top of. */
export const SOCIAL_COPY = COPY

const interpolate = (s, vars) =>
  typeof s === 'string' ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s

/**
 * @param {string} locale a language subtag; anything unlisted falls back to `en`
 * @param {'greeting'|'identity'|'thanks'|'farewell'} kind
 * @param {Record<string, unknown>} vars values for `{name}` slots in an override
 */
export function socialCopy(locale, kind, vars = {}) {
  const set = COPY[locale] || COPY.en
  const copy = set[kind] || set.greeting
  // Shipped copy carries no slots, so this is a no-op until someone overrides a
  // line and puts one in. Applied unconditionally so both paths behave alike.
  return {
    lead: interpolate(copy.lead, vars),
    body: interpolate(copy.body, vars),
    invite: interpolate(copy.invite, vars),
  }
}
