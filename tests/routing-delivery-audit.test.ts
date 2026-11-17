import test from "node:test";
import assert from "node:assert/strict";
import { auditRoutingDelivery } from "../lib/router/routing-delivery-audit";

test("production biography request fails audit if replaced by an image", () => {
  const result = auditRoutingDelivery({
    userMessage: "FB is all I want. write me a revised bio that will land! and get me the chick like the one GPT made 😏😂",
    selectedIntent: "image-generation",
    answer: "[Image Generated]",
    imageCount: 1
  });
  assert.equal(result.status, "fail");
  assert.equal(result.reason, "written_deliverable_missing");
  assert.equal(result.requestedImage, false);
});

test("actual written bio succeeds even if previous images are mentioned", () => {
  const result = auditRoutingDelivery({
    userMessage: "Write me a revised bio about my life inspired by that image.",
    selectedIntent: "rewrite",
    answer: "Coffee, faith and salty air. I build businesses, run the beach, and love a sharp sense of humor.",
    imageCount: 0
  });
  assert.equal(result.status, "unverified");
  assert.equal(result.reason, "written_output_unverified");
});

test("genuine compound deliverables report incomplete when either output is missing", () => {
  const userMessage = "Write a short profile bio and generate a portrait.";
  assert.equal(auditRoutingDelivery({ userMessage, selectedIntent: "rewrite", answer: "Here is your bio.", imageCount: 0 }).reason,
    "compound_deliverable_incomplete");
  assert.equal(auditRoutingDelivery({ userMessage, selectedIntent: "image-generation", answer: "[Image Generated]", imageCount: 1 }).reason,
    "compound_deliverable_incomplete");
  assert.equal(auditRoutingDelivery({ userMessage, selectedIntent: "rewrite", answer: "I enjoy sunny mornings.", imageCount: 1 }).status,
    "unverified");
});

test("explicit image generation requires actual image output", () => {
  assert.equal(auditRoutingDelivery({
    userMessage: "Generate a portrait of a cheerful woman.",
    selectedIntent: "image-generation",
    answer: "Here is the image.",
    imageCount: 0
  }).reason, "image_deliverable_missing");
});

test("ambiguous conversation is unverified rather than automatically failed", () => {
  const result = auditRoutingDelivery({
    userMessage: "That's hilarious, what do you think?",
    selectedIntent: "social-emotional",
    answer: "I think it was a good joke.",
    imageCount: 0
  });
  assert.equal(result.status, "unverified");
});

test("image acknowledgment cannot certify a written component", () => {
  const result = auditRoutingDelivery({
    userMessage: "Write a short profile bio and generate a portrait.",
    selectedIntent: "rewrite",
    answer: "Here is the portrait you requested.",
    imageCount: 1
  });
  assert.equal(result.status, "unverified");
  assert.equal(result.reason, "written_output_unverified");
});

test("writing words onto an image is audited as an image edit", () => {
  const result = auditRoutingDelivery({
    userMessage: 'Write the text "Happy birthday" onto the attached picture.',
    selectedIntent: "image-generation",
    answer: "[Image Generated]",
    imageCount: 1
  });
  assert.equal(result.requestedText, false);
  assert.equal(result.requestedImage, true);
  assert.equal(result.status, "pass");
});
