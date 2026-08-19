import { classifyTask } from '../src/domain/task-classification.js';
const t = 'Scope the control upgrade at Southbank PS';
console.log(JSON.stringify(classifyTask({ title: t, description: 'Mac, tonight scope the control upgrade at Southbank PS.' })));
