import { classifyTask } from '../src/domain/task-classification.js';
const title = 'Investigate whether we should replace the old S7-300 at Northgate WTP or migrate it incrementally';
const description = 'Mac, tonight investigate whether we should replace the old S7-300 at Northgate WTP or migrate it incrementally.';
console.log('title only:', JSON.stringify(classifyTask({ title })));
console.log('with desc :', JSON.stringify(classifyTask({ title, description })));
