const fs = require('fs');
const css = `
.custom-option:hover { background: rgba(255,255,255,0.1) !important; color: #66fcf1 !important; }
.custom-select-trigger:hover { border-color: rgba(102, 252, 241, 0.5) !important; background: rgba(102, 252, 241, 0.03) !important; }
.custom-select-trigger.open { border-color: rgba(102, 252, 241, 0.5) !important; box-shadow: 0 0 0 3px rgba(102, 252, 241, 0.08) !important; }
.custom-select-trigger.open svg { transform: rotate(180deg) !important; }
`;
fs.appendFileSync('frontend/web/public/css/styles.css', css);
