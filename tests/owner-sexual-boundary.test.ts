import test from "node:test";
import assert from "node:assert/strict";
import {
  isOwnerEroticRequest, looksLikeEroticAssistantOutput,
  OWNER_SEXUAL_BOUNDARY_INSTRUCTIONS, OWNER_SEXUAL_BOUNDARY_REPLY,
} from "../lib/chat/owner-sexual-boundary";

test("owner boundary blocks clearly requested erotic role-play", () => {
  for (const text of [
    "Katie, can we do erotic role-play?",
    "Write a steamy scene with me.",
    "Please sext with me.",
    "Talk dirty to me.",
    "Pretend you're my lover and we're naked.",
    "Can you describe how we have sex?",
    "Turn me on.",
    "I want you to make me orgasm.",
    "Let's continue our sexual roleplay.",
  ]) assert.equal(isOwnerEroticRequest(text), true, text);
});

test("owner can discuss personal concerns, health, faith and ordinary romance", () => {
  for (const text of [
    "Please help me stop erotic role-play.",
    "I want to delete all the sexual images and conversations.",
    "I am struggling with masturbation and I want to quit.",
    "How can I prevent sexting in my AI app?",
    "Why did sexual abuse cause trauma?",
    "Can we discuss sexual health and consent?",
    "I want to honor God and confess my mistakes.",
    "Please write a loving but non-sexual note to my girlfriend.",
    "Role-play a job interview.",
    "Write a scene about a family reunion.",
    "Let's talk about intimacy and boundaries.",
    "Do not continue an erotic scene.",
  ]) assert.equal(isOwnerEroticRequest(text), false, text);
});

test("short continuations of prior erotic role-play are blocked", () => {
  const history = [
    { role: "user", content: "Let's do erotic roleplay." },
    { role: "assistant", content: "I will not do that." },
  ];
  assert.equal(isOwnerEroticRequest("Continue", history), true);
  assert.equal(isOwnerEroticRequest("Again!", history), true);
  assert.equal(isOwnerEroticRequest("What's next for our budget?", history), false);
  assert.equal(isOwnerEroticRequest("More", [
    { role: "assistant", content: "We discussed sexual health and consent clinically." }
  ]), false);
  assert.equal(isOwnerEroticRequest("Continue", [
    { role: "user", content: "I want to stop using AI for erotic role-play." }
  ]), false);
});

test("final screen catches immersive explicit text but allows discussion", () => {
  assert.equal(looksLikeEroticAssistantOutput("I undress slowly and we begin to kiss."), true);
  assert.equal(looksLikeEroticAssistantOutput("You touch my breasts and pull me closer."), true);
  assert.equal(looksLikeEroticAssistantOutput("Masturbation can be discussed without shame in clinical terms."), false);
  assert.equal(looksLikeEroticAssistantOutput("We can talk about consent and boundaries."), false);
  assert.equal(looksLikeEroticAssistantOutput("I want to help you stop erotic role-play."), false);
});

test("owner policy is routing independent and references his decision", () => {
  assert.match(OWNER_SEXUAL_BOUNDARY_INSTRUCTIONS, /SERVER ENFORCED/);
  assert.match(OWNER_SEXUAL_BOUNDARY_INSTRUCTIONS, /manual override/);
  assert.match(OWNER_SEXUAL_BOUNDARY_INSTRUCTIONS, /trauma|health/);
  assert.match(OWNER_SEXUAL_BOUNDARY_REPLY, /honoring God/);
});
