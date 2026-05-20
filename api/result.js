const GHL_BASE_URL = "https://services.leadconnectorhq.com";
const GHL_VERSION = "2023-02-21";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

module.exports = async function handler(req, res) {
  setCorsHeaders(res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      ok: false,
      error: "Method not allowed",
    });
  }

  try {
    assertEnv(process.env);

    const body = await readRequestBody(req);
    const email = clean(body.email).toLowerCase();
    const contactId = clean(body.contactId || body.contact_id);
    const submissionId = clean(body.submissionId || body.submission_id);
    const surveyId = clean(body.surveyId || body.survey_id || process.env.DEFAULT_SURVEY_ID);

    if (!email && !contactId && !submissionId) {
      return res.status(400).json({
        ok: false,
        error: "Provide email, contactId, or submissionId.",
      });
    }

    const submission = await findMatchingSurveySubmission(process.env, {
      email,
      contactId,
      submissionId,
      surveyId,
    });

    if (!submission) {
      return res.status(404).json({
        ok: false,
        error:
          "No matching completed survey submission was found yet. If the survey was just submitted, wait a few seconds and check again.",
      });
    }

    const answers = normaliseAnswers(submission);
    const result = calculateOpsHealthCheck(answers);
    const matchedEmail =
      getAnswerValue(answers, ["email", "email address", "your email"]) ||
      email ||
      submission.email ||
      "";
    const contactName =
      getAnswerValue(answers, ["name", "your name", "full name"]) ||
      submission.name ||
      submission.contactName ||
      "";

    return res.status(200).json({
      ok: true,
      surveyId,
      submissionId: submission.id || submission.submissionId || submission._id || "",
      contactId: submission.contactId || submission.contact_id || "",
      email: matchedEmail,
      contactName,
      submittedAt: submission.createdAt || submission.submittedAt || submission.dateAdded || "",
      answers,
      result,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error && error.message ? error.message : "Unexpected server error.",
    });
  }
};

function setCorsHeaders(res) {
  for (const [key, value] of Object.entries(corsHeaders)) {
    res.setHeader(key, value);
  }
  res.setHeader("Content-Type", "application/json; charset=utf-8");
}

function assertEnv(env) {
  if (!env.GHL_PRIVATE_INTEGRATION_TOKEN) {
    throw new Error("Missing GHL_PRIVATE_INTEGRATION_TOKEN secret.");
  }

  if (!env.GHL_LOCATION_ID) {
    throw new Error("Missing GHL_LOCATION_ID variable.");
  }
}

function clean(value) {
  return String(value == null ? "" : value).trim();
}

async function readRequestBody(req) {
  if (req.body && typeof req.body === "object") {
    return req.body;
  }

  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch (_) {
      return {};
    }
  }

  return new Promise((resolve, reject) => {
    let raw = "";

    req.on("data", (chunk) => {
      raw += chunk;
    });

    req.on("end", () => {
      if (!raw) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(raw));
      } catch (_) {
        resolve({});
      }
    });

    req.on("error", reject);
  });
}

async function ghlFetch(env, path) {
  const response = await fetch(`${GHL_BASE_URL}${path}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${env.GHL_PRIVATE_INTEGRATION_TOKEN}`,
      Version: GHL_VERSION,
      Accept: "application/json",
    },
  });

  const text = await response.text();
  let data;

  try {
    data = text ? JSON.parse(text) : {};
  } catch (_) {
    data = { raw: text };
  }

  if (!response.ok) {
    throw new Error(data.message || data.error || `GHL API request failed with status ${response.status}.`);
  }

  return data;
}

async function findMatchingSurveySubmission(env, lookup) {
  if (lookup.submissionId) {
    const submissions = await getSurveySubmissions(env, lookup.surveyId, "");
    return submissions.find((item) => String(item.id || item.submissionId || item._id || "") === lookup.submissionId) || null;
  }

  const q = lookup.email || lookup.contactId || "";
  let submissions = await getSurveySubmissions(env, lookup.surveyId, q);

  if (!submissions.length && q) {
    submissions = await getSurveySubmissions(env, lookup.surveyId, "");
  }

  const matches = submissions.filter((submission) => submissionMatches(submission, lookup));
  return sortNewest(matches)[0] || null;
}

async function getSurveySubmissions(env, surveyId, q) {
  const params = new URLSearchParams();
  params.set("locationId", env.GHL_LOCATION_ID);

  if (surveyId) params.set("surveyId", surveyId);
  if (q) params.set("q", q);

  params.set("limit", "100");
  params.set("page", "1");

  const data = await ghlFetch(env, `/surveys/submissions?${params.toString()}`);
  return extractSubmissionArray(data);
}

function extractSubmissionArray(data) {
  const candidates = [
    data.submissions,
    data.surveySubmissions,
    data.results,
    data.items,
    data.data,
    data.contacts,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
    if (candidate && Array.isArray(candidate.submissions)) return candidate.submissions;
    if (candidate && Array.isArray(candidate.items)) return candidate.items;
  }

  return [];
}

function submissionMatches(submission, lookup) {
  const answers = normaliseAnswers(submission);
  const emailValues = [
    submission.email,
    submission.contactEmail,
    submission.emailAddress,
    getAnswerValue(answers, ["email", "email address", "your email"]),
  ]
    .map((value) => clean(value).toLowerCase())
    .filter(Boolean);

  const contactValues = [submission.contactId, submission.contact_id, submission.contact?.id]
    .map(clean)
    .filter(Boolean);

  if (lookup.email && emailValues.includes(lookup.email.toLowerCase())) return true;
  if (lookup.contactId && contactValues.includes(lookup.contactId)) return true;

  const blob = JSON.stringify(submission).toLowerCase();
  if (lookup.email && blob.includes(lookup.email.toLowerCase())) return true;
  if (lookup.contactId && blob.includes(lookup.contactId.toLowerCase())) return true;

  return false;
}

function sortNewest(items) {
  return items.slice().sort((a, b) => {
    const ad = Date.parse(a.createdAt || a.submittedAt || a.dateAdded || a.updatedAt || 0) || 0;
    const bd = Date.parse(b.createdAt || b.submittedAt || b.dateAdded || b.updatedAt || 0) || 0;
    return bd - ad;
  });
}

function normaliseAnswers(submission) {
  const raw = [];

  const containers = [
    submission.answers,
    submission.questions,
    submission.formData,
    submission.customFields,
    submission.fields,
    submission.values,
    submission.submission,
  ];

  for (const container of containers) {
    if (Array.isArray(container)) {
      raw.push(...container);
    } else if (container && typeof container === "object") {
      for (const [key, value] of Object.entries(container)) {
        raw.push({ key, label: key, value });
      }
    }
  }

  if (!raw.length && submission && typeof submission === "object") {
    for (const [key, value] of Object.entries(submission)) {
      if (!["id", "submissionId", "contactId", "createdAt", "updatedAt"].includes(key)) {
        raw.push({ key, label: key, value });
      }
    }
  }

  return raw
    .map((item) => {
      const label = clean(item.label || item.name || item.question || item.title || item.key || item.fieldKey || item.id);
      let value =
        item.value ??
        item.answer ??
        item.field_value ??
        item.fieldValue ??
        item.selectedOptions ??
        item.options ??
        "";

      if (Array.isArray(value)) {
        value = value
          .map((entry) => (typeof entry === "object" ? clean(entry.label || entry.name || entry.value || JSON.stringify(entry)) : clean(entry)))
          .filter(Boolean);
      } else if (value && typeof value === "object") {
        value = clean(value.label || value.name || value.value || JSON.stringify(value));
      } else {
        value = clean(value);
      }

      return { key: clean(item.key || item.fieldKey || item.id || label), label, value };
    })
    .filter((item) => item.label || item.key);
}

function norm(value) {
  return clean(Array.isArray(value) ? value.join(", ") : value)
    .toLowerCase()
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function getAnswerValue(answers, labels) {
  const wanted = labels.map(norm);
  const found = answers.find((answer) => {
    const key = norm(answer.key);
    const label = norm(answer.label);
    return wanted.some((needle) => key.includes(needle) || label.includes(needle));
  });

  return found ? found.value : "";
}

function answerIncludes(value, text) {
  const target = norm(text);
  if (Array.isArray(value)) return value.some((item) => norm(item).includes(target));
  return norm(value).includes(target);
}

function scoreByMap(value, map, fallback = 0) {
  const valueNorm = norm(value);
  for (const [answer, points] of Object.entries(map)) {
    if (valueNorm === norm(answer) || valueNorm.includes(norm(answer))) return points;
  }
  return fallback;
}

function calculateOpsHealthCheck(answers) {
  const q1 = getAnswerValue(answers, ["time on admin", "hours per week", "administrative tasks", "q1"]);
  const q2 = getAnswerValue(answers, ["delegation experience", "previously delegated", "hired support", "q2"]);
  const q3 = getAnswerValue(answers, ["delegation outcome", "describe that experience", "q3"]);
  const q5 = getAnswerValue(answers, ["biggest pain point", "operational challenge", "bottleneck", "q5"]);
  const q6 = getAnswerValue(answers, ["growth plans", "growth goals", "next 12 months", "q6"]);
  const q7 = getAnswerValue(answers, ["impact of admin", "strategic growth", "client work", "q7"]);
  const q8 = getAnswerValue(answers, ["team size", "team members", "business operations", "q8"]);
  const q9 = getAnswerValue(answers, ["documentation", "sop", "standard operating", "q9"]);
  const q10 = getAnswerValue(answers, ["tech adoption", "technology", "ai tools", "q10"]);
  const q11 = getAnswerValue(answers, ["values alignment", "business values", "q11"]);
  const q12 = getAnswerValue(answers, ["desired outcome", "magically solve", "operational problem", "q12"]);

  const q1Score = scoreByMap(q1, { "0-5": 1, "0–5": 1, "6-10": 2, "6–10": 2, "11-15": 3, "11–15": 3, "16-20": 4, "16–20": 4, "20+": 5 });
  const q7Score = scoreByMap(q7, { "not at all": 1, "minor inconvenience": 2, "moderately impacts": 4, "significantly hinders": 5 });
  const q8LoadScore = scoreByMap(q8, { "1 (just me)": 5, "1 (solo)": 5, "1": 5, "2-5": 3, "2–5": 3, "6-10": 2, "6–10": 2, "10+": 1 });
  const q9LoadScore = scoreByMap(q9, { "yes, for most": 1, "some": 3, "very few": 4, "no": 5 });

  const q6ComplexityScore = scoreQ6(q6);
  const q8ComplexityScore = scoreByMap(q8, { "1 (just me)": 1, "1 (solo)": 1, "1": 1, "2-5": 4, "2–5": 4, "6-10": 5, "6–10": 5, "10+": 5 });
  const q9ComplexityScore = scoreByMap(q9, { "yes, for most": 1, "some": 2, "very few": 4, "no": 5 });

  const operationalLoadScore = q1Score + q7Score + q8LoadScore + q9LoadScore;
  const complexityScore = q6ComplexityScore + q8ComplexityScore + q9ComplexityScore;

  let category;
  if (operationalLoadScore <= 8) category = "NO_SUPPORT";
  else if (operationalLoadScore <= 14 && complexityScore < 8) category = "VA_SUPPORT";
  else if (operationalLoadScore <= 14 && complexityScore >= 8) category = "OBM_SUPPORT";
  else if (operationalLoadScore >= 15 && complexityScore < 8) category = "VA_INTENSIVE";
  else category = "OBM_SUPPORT";

  const modifiers = [];
  if (answerIncludes(q2, "no") && q1Score >= 4) {
    modifiers.push({
      code: "first_time_delegator_high_admin",
      label: "You have not delegated before, and admin pressure is high. Start with calm, task-level support before adding management complexity.",
    });
    if (category === "OBM_SUPPORT" && complexityScore < 10) category = "VA_SUPPORT";
  }
  if (answerIncludes(q3, "challenging") || answerIncludes(q3, "didn't work out") || answerIncludes(q3, "did not work out")) {
    modifiers.push({
      code: "previous_delegation_concern",
      label: "Your previous delegation experience needs to be acknowledged directly before recommending the next step.",
    });
  }
  if (answerIncludes(q10, "somewhat hesitant") || answerIncludes(q10, "prefer traditional")) {
    modifiers.push({
      code: "human_first_tech_tone",
      label: "Follow-up should lead with the human side of support, not technology or AI.",
    });
  }
  if (answerIncludes(q11, "extremely important")) {
    modifiers.push({
      code: "values_alignment",
      label: "Values alignment should be part of the follow-up framing.",
    });
  }

  return {
    operationalLoadScore,
    complexityScore,
    category,
    modifiers,
    capturedOpenText: {
      biggestPainPoint: q5,
      desiredOutcome: q12,
    },
    breakdown: {
      q1Score,
      q7Score,
      q8LoadScore,
      q9LoadScore,
      q6ComplexityScore,
      q8ComplexityScore,
      q9ComplexityScore,
    },
    copy: resultCopy(category),
  };
}

function scoreQ6(value) {
  const values = Array.isArray(value) ? value : String(value || "").split(/,|;/).map((entry) => entry.trim()).filter(Boolean);
  const scores = values.map((item) =>
    scoreByMap(
      item,
      {
        "improve efficiency": 1,
        "increase revenue": 2,
        "launch a new product or service": 4,
        "expand the team": 5,
      },
      0,
    ),
  );

  return scores.length ? Math.max(...scores) : 0;
}

function resultCopy(category) {
  const noSupport = {
    headline: "you're in a decent spot",
    paragraphs: [
      "Based on your answers, your operations are in a workable place. You've got systems, your team set-up is functional, and admin isn't pulling you away from the work that matters most.",
      "That can change quickly. Growth, a new launch, an unexpected month, a team shift. Any of these can tip things over. So it's worth knowing where you'd turn when that happens.",
      "I'll send you a short follow-up with the hiring cost calculator and a few things to keep an eye on as you grow. No pressure. The work will still be there when you need it.",
    ],
  };

  const va = {
    headline: "you need to get some hours back",
    paragraphs: [
      "Your answers suggest you're carrying more admin than your business should be costing you. Whether you've delegated before or not, the move here is task-level support. Someone reliable handling the recurring work so you can focus on what only you can do.",
      "A VA isn't a magic wand. It only works when the right tasks get handed over and there's a bit of structure around the handover. That's what my team is built for. Practical, calm support without the chaos of starting from scratch.",
      "Book a 30-minute ops health check call and we'll talk through what's actually pulling at your time and where to start.",
    ],
  };

  const obm = {
    headline: "you've outgrown task-level help",
    paragraphs: [
      "Your answers point to something more than admin. You've got a team, a growth plan, and not enough underneath it to hold the weight. That's not a VA problem. That's an operations problem.",
      "An OBM works at the management layer. Systems, processes, team oversight, the things that stop a growing business from running on you and your phone. It's the role that gives you back actual headspace, not just hours.",
      "Book a 30-minute ops health check call. We'll look at what's actually going on and whether OBM support is the right fit.",
    ],
  };

  if (category === "NO_SUPPORT") return noSupport;
  if (category === "OBM_SUPPORT") return obm;
  return va;
}
