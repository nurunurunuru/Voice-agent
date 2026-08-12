// server/liveSession.js
// Browser <--WS--> Node.js Server <--WS--> Gemini Live API

const WebSocket = require("ws");
const { embedText } = require("./embeddings");
const vectorStore = require("./vectorStore");

const GEMINI_WS_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

const SEARCH_TOOL_NAME = "search_website_info";

/**
 * Gemini Live API setup message
 */
function buildSetupMessage({ model, systemPrompt }) {
  return {
    setup: {
      model: `models/${model}`,

      // IMPORTANT:
      // responseModalities must be inside generationConfig
      generationConfig: {
        responseModalities: ["AUDIO"],

        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: "Aoede",
            },
          },
        },
      },

      systemInstruction: {
        parts: [
          {
            text: systemPrompt,
          },
        ],
      },

      tools: [
        {
          functionDeclarations: [
            {
              name: SEARCH_TOOL_NAME,
              description:
                "এই ওয়েবসাইটের ট্রেইন করা তথ্য থেকে ইউজারের প্রশ্নের সাথে সম্পর্কিত তথ্য খুঁজে বের করে। ওয়েবসাইটের নির্দিষ্ট তথ্য জানতে চাইলে এই tool ব্যবহার করো। অনুমান করে তথ্য তৈরি করো না।",

              parameters: {
                type: "OBJECT",

                properties: {
                  query: {
                    type: "STRING",
                    description:
                      "ইউজারের প্রশ্নের মূল বিষয় বা keyword",
                  },
                },

                required: ["query"],
              },
            },
          ],
        },
      ],

      realtimeInputConfig: {
        automaticActivityDetection: {
          disabled: false,
        },
      },
    },
  };
}

/**
 * Browser <-> Gemini Live bridge
 */
function startBridge(browserWs, opts) {
  const {
    agentId,
    apiKey,
    model,
  } = opts;

  console.log("");
  console.log("=================================");
  console.log("🎙️ Starting Voice Agent Bridge");
  console.log("Agent ID:", agentId);
  console.log("Model:", model);
  console.log("=================================");

  // Load trained agent
  const agentStore = vectorStore.loadStore(agentId);

  if (!agentStore) {
    console.error("❌ Agent store not found:", agentId);

    if (browserWs.readyState === WebSocket.OPEN) {
      browserWs.send(
        JSON.stringify({
          type: "error",
          message:
            "এই agentId এর জন্য কোনো training data পাওয়া যায়নি। আগে /api/train কল করুন।",
        })
      );

      browserWs.close();
    }

    return;
  }

  console.log(
    `✅ Agent loaded: ${agentStore.siteName}`
  );

  // System prompt
  const systemPrompt =
    agentStore.systemPrompt ||
    `
তুমি "${agentStore.siteName}" ওয়েবসাইটের একজন helpful voice assistant।

শুধুমাত্র এই ওয়েবসাইট এবং এর services সম্পর্কিত প্রশ্নের উত্তর দেবে।

ওয়েবসাইটের নির্দিষ্ট তথ্য যেমন:
- Services
- Products
- Pricing
- Policies
- Contact information
- FAQs

জানতে চাইলে অবশ্যই "${SEARCH_TOOL_NAME}" tool ব্যবহার করবে।

নিজে থেকে কোনো তথ্য অনুমান করে বানিয়ে বলবে না।

ব্যবহারকারী যে ভাষায় প্রশ্ন করবে সেই ভাষাতেই উত্তর দেবে।
বাংলায় প্রশ্ন করলে বাংলায় উত্তর দেবে।
ইংরেজিতে প্রশ্ন করলে ইংরেজিতে উত্তর দেবে।

উত্তর সংক্ষিপ্ত, পরিষ্কার এবং friendly রাখবে।
`.trim();

  // Gemini WebSocket
  const geminiUrl =
    `${GEMINI_WS_URL}?key=${encodeURIComponent(apiKey)}`;

  console.log("🔌 Connecting to Gemini...");

  const geminiWs = new WebSocket(geminiUrl);

  let setupDone = false;

  // Browser থেকে setup হওয়ার আগেই message এলে এখানে রাখা হবে
  const pendingFromBrowser = [];

  // ============================================
  // GEMINI OPEN
  // ============================================

  geminiWs.on("open", () => {
    console.log("🟢 Gemini WebSocket OPEN");

    const setupMessage = buildSetupMessage({
      model,
      systemPrompt,
    });

    console.log("📤 Sending Gemini setup...");

    geminiWs.send(
      JSON.stringify(setupMessage)
    );
  });

  // ============================================
  // GEMINI MESSAGE
  // ============================================

  geminiWs.on("message", async (raw) => {
    let msg;

    try {
      msg = JSON.parse(raw.toString());
    } catch (err) {
      console.error(
        "❌ Invalid Gemini JSON:",
        err.message
      );

      return;
    }

    // --------------------------------------------
    // Setup complete
    // --------------------------------------------

    if (msg.setupComplete) {
      setupDone = true;

      console.log(
        "✅ Gemini setup complete"
      );

      if (browserWs.readyState === WebSocket.OPEN) {
        browserWs.send(
          JSON.stringify({
            type: "ready",
          })
        );
      }

      // Setup হওয়ার আগে browser থেকে আসা message পাঠানো
      if (pendingFromBrowser.length > 0) {
        console.log(
          `📨 Sending ${pendingFromBrowser.length} pending messages`
        );

        for (
          const message of pendingFromBrowser.splice(0)
        ) {
          if (
            geminiWs.readyState === WebSocket.OPEN
          ) {
            geminiWs.send(message);
          }
        }
      }

      return;
    }

    // --------------------------------------------
    // Gemini error
    // --------------------------------------------

    if (msg.error) {
      console.error(
        "❌ Gemini API error:",
        JSON.stringify(msg.error, null, 2)
      );

      if (browserWs.readyState === WebSocket.OPEN) {
        browserWs.send(
          JSON.stringify({
            type: "error",
            message:
              msg.error.message ||
              "Gemini API error",
          })
        );
      }

      return;
    }

    // --------------------------------------------
    // Tool call
    // --------------------------------------------

    if (
      msg.toolCall &&
      Array.isArray(msg.toolCall.functionCalls)
    ) {
      console.log(
        "🔎 Gemini requested tool call"
      );

      const responses = [];

      for (
        const call of msg.toolCall.functionCalls
      ) {
        if (
          call.name !== SEARCH_TOOL_NAME
        ) {
          continue;
        }

        const query =
          call.args?.query || "";

        console.log(
          "🔍 Searching website:",
          query
        );

        let resultText =
          "কোনো তথ্য পাওয়া যায়নি।";

        try {
          // Query embedding
          const qEmbedding =
            await embedText(
              apiKey,
              query
            );

          // Search vector database
          const top =
            vectorStore.search(
              agentId,
              qEmbedding,
              4
            );

          if (top && top.length > 0) {
            resultText = top
              .map(
                (chunk, index) =>
                  `[${index + 1}] ${
                    chunk.title ||
                    chunk.url ||
                    "Website content"
                  }\n${chunk.text}`
              )
              .join("\n\n");
          }

          console.log(
            `✅ Found ${top?.length || 0} relevant chunks`
          );
        } catch (err) {
          console.error(
            "❌ Vector search error:",
            err.message
          );

          resultText =
            "ওয়েবসাইটের তথ্য খুঁজতে সমস্যা হয়েছে।";
        }

        responses.push({
          id: call.id,
          name: call.name,

          response: {
            result: resultText,
          },
        });
      }

      // Tool response Gemini-তে পাঠানো
      if (
        responses.length > 0 &&
        geminiWs.readyState === WebSocket.OPEN
      ) {
        console.log(
          "📤 Sending tool response to Gemini"
        );

        geminiWs.send(
          JSON.stringify({
            toolResponse: {
              functionResponses:
                responses,
            },
          })
        );
      }

      return;
    }

    // --------------------------------------------
    // Gemini server content
    // --------------------------------------------

    if (msg.serverContent) {
      if (
        browserWs.readyState === WebSocket.OPEN
      ) {
        browserWs.send(
          JSON.stringify({
            type: "serverContent",
            data: msg.serverContent,
          })
        );
      }

      return;
    }

    // --------------------------------------------
    // Session resumption
    // --------------------------------------------

    if (msg.sessionResumptionUpdate) {
      if (
        browserWs.readyState === WebSocket.OPEN
      ) {
        browserWs.send(
          JSON.stringify({
            type: "sessionResumptionUpdate",
            data:
              msg.sessionResumptionUpdate,
          })
        );
      }

      return;
    }

    // --------------------------------------------
    // GoAway
    // --------------------------------------------

    if (msg.goAway) {
      console.log(
        "⚠️ Gemini sent goAway"
      );

      if (
        browserWs.readyState === WebSocket.OPEN
      ) {
        browserWs.send(
          JSON.stringify({
            type: "goAway",
            data: msg.goAway,
          })
        );
      }

      return;
    }
  });

  // ============================================
  // GEMINI CLOSE
  // ============================================

  geminiWs.on("close", (code, reason) => {
    console.log("");
    console.log(
      "🔴 Gemini WebSocket CLOSED"
    );
    console.log("Close code:", code);
    console.log(
      "Close reason:",
      reason?.toString() || "<empty>"
    );

    if (
      browserWs.readyState === WebSocket.OPEN
    ) {
      browserWs.send(
        JSON.stringify({
          type: "closed",
          code,
          reason:
            reason?.toString() || "",
        })
      );

      browserWs.close();
    }
  });

  // ============================================
  // GEMINI ERROR
  // ============================================

  geminiWs.on("error", (err) => {
    console.error(
      "❌ Gemini WebSocket error:",
      err.message
    );

    if (
      browserWs.readyState === WebSocket.OPEN
    ) {
      browserWs.send(
        JSON.stringify({
          type: "error",
          message:
            "Voice service error: " +
            err.message,
        })
      );
    }
  });

  // ============================================
  // BROWSER MESSAGE
  // ============================================

  browserWs.on("message", (raw) => {
    let clientMsg;

    try {
      clientMsg = JSON.parse(
        raw.toString()
      );
    } catch (err) {
      console.error(
        "❌ Invalid browser JSON:",
        err.message
      );

      return;
    }

    let forward = null;

    // --------------------------------------------
    // Audio
    // --------------------------------------------

    if (clientMsg.type === "audio") {
      forward = {
        realtimeInput: {
          audio: {
            data: clientMsg.data,
            mimeType:
              "audio/pcm;rate=16000",
          },
        },
      };
    }

    // --------------------------------------------
    // Text
    // --------------------------------------------

    else if (
      clientMsg.type === "text"
    ) {
      forward = {
        clientContent: {
          turns: [
            {
              role: "user",
              parts: [
                {
                  text:
                    clientMsg.data || "",
                },
              ],
            },
          ],
          turnComplete: true,
        },
      };
    }

    // --------------------------------------------
    // End audio turn
    // --------------------------------------------

    else if (
      clientMsg.type ===
      "end_audio_turn"
    ) {
      forward = {
        realtimeInput: {
          audioStreamEnd: true,
        },
      };
    }

    // Unknown message
    else {
      console.log(
        "⚠️ Unknown browser message:",
        clientMsg.type
      );

      return;
    }

    const payload =
      JSON.stringify(forward);

    // Gemini ready হলে সরাসরি পাঠাও
    if (
      setupDone &&
      geminiWs.readyState ===
        WebSocket.OPEN
    ) {
      geminiWs.send(payload);
    }

    // Gemini এখনও setup না হলে queue করো
    else {
      pendingFromBrowser.push(payload);
    }
  });

  // ============================================
  // BROWSER CLOSE
  // ============================================

  browserWs.on("close", () => {
    console.log(
      "🔴 Browser WebSocket CLOSED"
    );

    if (
      geminiWs.readyState ===
        WebSocket.OPEN ||
      geminiWs.readyState ===
        WebSocket.CONNECTING
    ) {
      geminiWs.close();
    }
  });
}

module.exports = {
  startBridge,
};