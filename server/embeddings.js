// server/embeddings.js
// Gemini Embedding API - batch REST wrapper

const EMBED_MODEL =
  process.env.GEMINI_EMBED_MODEL || "gemini-embedding-001";

const BATCH_SIZE =
  Number(process.env.EMBED_BATCH_SIZE) || 50;

const MAX_RETRIES =
  Number(process.env.EMBED_MAX_RETRIES) || 6;

const BASE_RETRY_DELAY =
  Number(process.env.EMBED_RETRY_DELAY_MS) || 5000;


// ============================================================
// Sleep
// ============================================================

function sleep(ms) {
  return new Promise((resolve) =>
    setTimeout(resolve, ms)
  );
}


// ============================================================
// Single embedding
// ============================================================

async function embedText(apiKey, text) {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:embedContent`;

  const res = await fetch(url, {
    method: "POST",

    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },

    body: JSON.stringify({
      model: `models/${EMBED_MODEL}`,

      content: {
        parts: [
          {
            text,
          },
        ],
      },

      taskType: "RETRIEVAL_DOCUMENT",
    }),
  });

  if (!res.ok) {
    const errText = await res.text();

    throw new Error(
      `Embedding request failed: ${res.status} ${errText}`
    );
  }

  const data = await res.json();

  if (!data.embedding?.values) {
    throw new Error(
      "Gemini returned no embedding values"
    );
  }

  return data.embedding.values;
}


// ============================================================
// Batch embedding
// ============================================================

async function embedBatchRequest(
  apiKey,
  texts
) {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:batchEmbedContents`;

  const requests = texts.map((text) => ({
    model: `models/${EMBED_MODEL}`,

    content: {
      parts: [
        {
          text,
        },
      ],
    },

    taskType:
      "RETRIEVAL_DOCUMENT",
  }));


  for (
    let attempt = 0;
    attempt <= MAX_RETRIES;
    attempt++
  ) {

    const res = await fetch(url, {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },

      body: JSON.stringify({
        requests,
      }),
    });


    // --------------------------------------------------------
    // SUCCESS
    // --------------------------------------------------------

    if (res.ok) {
      const data =
        await res.json();

      if (
        !Array.isArray(
          data.embeddings
        )
      ) {
        throw new Error(
          "Gemini returned invalid batch embedding response"
        );
      }

      return data.embeddings.map(
        (item) =>
          item.values
      );
    }


    // --------------------------------------------------------
    // ERROR
    // --------------------------------------------------------

    const errText =
      await res.text();


    // --------------------------------------------------------
    // Non-retryable errors
    // --------------------------------------------------------

    if (
      res.status !== 429 &&
      res.status !== 500 &&
      res.status !== 502 &&
      res.status !== 503 &&
      res.status !== 504
    ) {
      throw new Error(
        `Batch embedding request failed: ${res.status} ${errText}`
      );
    }


    // --------------------------------------------------------
    // Retry
    // --------------------------------------------------------

    if (
      attempt >= MAX_RETRIES
    ) {
      throw new Error(
        `Batch embedding failed after ${MAX_RETRIES} retries: ${res.status} ${errText}`
      );
    }


    // Try to extract Google's retry delay
    let retrySeconds = null;

    try {
      const parsed =
        JSON.parse(errText);

      const retryDelay =
        parsed?.error?.details?.find(
          (detail) =>
            detail["@type"] ===
            "type.googleapis.com/google.rpc.RetryInfo"
        )?.retryDelay;

      if (retryDelay) {
        retrySeconds =
          parseFloat(
            retryDelay
              .replace("s", "")
          );
      }
    } catch {
      // Ignore invalid JSON
    }


    const exponentialDelay =
      BASE_RETRY_DELAY *
      Math.pow(2, attempt);

    const waitMs =
      retrySeconds
        ? retrySeconds * 1000 + 1000
        : exponentialDelay;


    console.log(
      `⚠️ Embedding API ${res.status}. Retry ${
        attempt + 1
      }/${MAX_RETRIES} in ${Math.ceil(
        waitMs / 1000
      )}s...`
    );


    await sleep(
      waitMs
    );
  }


  throw new Error(
    "Unexpected embedding error"
  );
}


// ============================================================
// Embed many texts
// ============================================================

async function embedBatch(
  apiKey,
  texts,
  options = {}
) {
  const batchSize =
    Number(
      options.batchSize ||
        BATCH_SIZE
    );

  if (!Array.isArray(texts)) {
    throw new Error(
      "texts must be an array"
    );
  }

  if (texts.length === 0) {
    return [];
  }


  const results =
    new Array(texts.length);


  const totalBatches =
    Math.ceil(
      texts.length /
        batchSize
    );


  console.log(
    `📦 Total texts: ${texts.length}`
  );

  console.log(
    `📦 Batch size: ${batchSize}`
  );

  console.log(
    `📦 Total API batches: ${totalBatches}`
  );


  for (
    let start = 0;
    start < texts.length;
    start += batchSize
  ) {

    const end =
      Math.min(
        start + batchSize,
        texts.length
      );


    const batch =
      texts.slice(
        start,
        end
      );


    const batchNumber =
      Math.floor(
        start / batchSize
      ) + 1;


    console.log(
      `🧠 Embedding batch ${batchNumber}/${totalBatches} — ${start + 1}-${end}`
    );


    const embeddings =
      await embedBatchRequest(
        apiKey,
        batch
      );


    if (
      embeddings.length !==
      batch.length
    ) {
      throw new Error(
        `Embedding count mismatch. Expected ${batch.length}, received ${embeddings.length}`
      );
    }


    for (
      let i = 0;
      i < embeddings.length;
      i++
    ) {
      results[
        start + i
      ] = embeddings[i];
    }


    console.log(
      `✅ Batch ${batchNumber}/${totalBatches} completed`
    );


    // Small pause between batches
    // to reduce burst pressure.
    if (
      end < texts.length
    ) {
      await sleep(1000);
    }
  }


  console.log(
    `🎉 All ${results.length} embeddings completed`
  );


  return results;
}


// ============================================================
// Cosine similarity
// ============================================================

function cosineSimilarity(
  a,
  b
) {
  if (
    !Array.isArray(a) ||
    !Array.isArray(b) ||
    a.length !== b.length
  ) {
    return 0;
  }


  let dot = 0;
  let normA = 0;
  let normB = 0;


  for (
    let i = 0;
    i < a.length;
    i++
  ) {
    dot +=
      a[i] * b[i];

    normA +=
      a[i] * a[i];

    normB +=
      b[i] * b[i];
  }


  if (
    normA === 0 ||
    normB === 0
  ) {
    return 0;
  }


  return (
    dot /
    (
      Math.sqrt(normA) *
      Math.sqrt(normB)
    )
  );
}


// ============================================================
// Exports
// ============================================================

module.exports = {
  embedText,
  embedBatch,
  cosineSimilarity,
};