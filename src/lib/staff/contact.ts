// Contact-log vocabulary shared by the API validation, the company page form and the reports.
export const CONTACT_CHANNELS = ["call", "email", "meeting", "other"] as const;
export const CONTACT_OUTCOMES = ["reached", "no_answer", "left_message", "callback_requested", "not_interested", "other"] as const;
export type ContactChannel = (typeof CONTACT_CHANNELS)[number];
export type ContactOutcome = (typeof CONTACT_OUTCOMES)[number];

export const CHANNEL_LABEL: Record<ContactChannel, string> = { call: "Phone call", email: "Email", meeting: "Meeting", other: "Other" };
export const OUTCOME_LABEL: Record<ContactOutcome, string> = {
  reached: "Spoke to someone",
  no_answer: "No answer",
  left_message: "Left a message",
  callback_requested: "Call-back requested",
  not_interested: "Not interested",
  other: "Other outcome",
};

// An attempt that reached no one is still a recorded contact ATTEMPT, but only these outcomes mean a person was actually
// reached. Reports show both numbers and never merge them.
export const REACHED_OUTCOMES: ContactOutcome[] = ["reached", "callback_requested", "not_interested"];
