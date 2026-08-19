import { classifyMessageIntent } from '../src/domain/message-intent.js';
const qs = [
  'What did you do last night?',
  "What's blocking Project 24123?",
  'What needs my approval?',
  'Did task 41 finish?',
  'What assumptions did you make?',
  'Which company context revision did you use?',
];
for (const q of qs) console.log(JSON.stringify(classifyMessageIntent(q)), '<-', q);
