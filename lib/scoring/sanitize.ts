// Instagram bios and captions routinely contain lone (unpaired) UTF-16
// surrogates — either malformed unicode straight from IG, or a valid emoji
// surrogate pair sliced in half by a `.slice(0, N)` on the caption. When such a
// string goes into a JSON request body, providers reject the whole request:
// OpenAI returns `400 {"code":"invalid_json"}` ("failed to parse JSON value"),
// which made score-lead exhaust its retries and leave leads stuck `pending`
// forever with no obvious cause. Replace any unpaired surrogate with U+FFFD (�)
// so the request body is always well-formed.
//
// Regex: a high surrogate not followed by a low surrogate, OR a low surrogate
// not preceded by a high surrogate.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function stripLoneSurrogates(text: string): string {
  return text.replace(LONE_SURROGATE, "�");
}
