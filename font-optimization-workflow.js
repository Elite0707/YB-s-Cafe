export const meta = {
  name: 'optimize-fonts',
  description: 'Analyze and fix font usage across the codebase for better performance and accessibility',
  phases: [
    { title: 'Audit', detail: 'Find all font-related code and assets' },
    { title: 'Analyze', detail: 'Evaluate font performance and accessibility' },
    { title: 'Fix', detail: 'Implement optimal font configurations' }
  ]
}

phase('Audit')
// Find all font-related code in the project
const auditReport = await agent(
  'Search the entire codebase for all font-related code: CSS font-family, Google Fonts imports, font imports, @font-face declarations, font optimization settings, font loading strategies, and any font-related configuration or comments. I need to capture every location where fonts are defined, imported, or used to understand the full scope of the font implementation.',
  {label: 'Font audit search', phase: 'Audit'}
)

// Extract specific issues from the audit
const issues = await agent(
  `Analyze the audit report and identify specific font-related problems:
1. Google Fonts import syntax issues (old semicolon vs newer & separator)
2. Font loading and performance issues (blocking vs non-blocking)
3. Web-safe font stack completeness
4. Missing font-display strategy
5. Font subsetting recommendations
6. Font weight optimization
7. Font format support (woff2, etc.)
8. CSS variable font usage
9. Font relationship to system performance
10. Font accessibility compliance (minimum 4.5:1 contrast)

Report all issues with severity and specific file locations.`,
  {label: 'Font issue analysis', phase: 'Audit', schema: {
    type: 'object',
    properties: {
      issues: {
        additionalProperties: false,
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: {type: 'string'},
            severity: {type: 'string', enum: ['critical', 'warning', 'info']},
            file: {type: 'string'},
            line: {type: 'integer'},
            description: {type: 'string'},
            recommendation: {type: 'string'}
          },
          required: ['type', 'severity', 'file', 'line', 'description', 'recommendation']
        }
      }
    },
    required: ['issues']
  }}
)

phase('Analyze')
const analysisReport = await agent(
  `Analyze the identified font issues for optimal fix strategies:
1. Prioritize critical issues that impact font loading performance
2. Suggest CSS-in-JS vs global CSS approaches for font optimization
3. Recommend font-face declarations over Google Fonts for better control
4. Suggest font-display optimization strategies
5. Provide specific implementation guidance for each issue
6. Consider system font stack fallbacks
7. Address font-weight optimization for better accessibility
8. Implement font subsetting strategies
9. Consider font loading intersection observer
10. Optimize font loading order and preconnect strategies

Return a prioritized fix plan with specific implementation guidance for each issue type.`,
  {label: 'Font optimization analysis', phase: 'Analyze'}
)

phase('Fix')
const fixes = await agent(
  `Based on the audit results and analysis, implement fixes for the identified font issues. Return a comprehensive plan including:
1. File-by-file modifications for critical issues
2. CSS optimization techniques (font-face, preconnect, font-display)
3. Font stack improvements (system fonts + web fonts)
4. Font loading strategy implementations
5. Performance optimization techniques
6. Accessibility compliance improvements
7. Specific code changes for each file
8. Validation steps for each fix

Provide detailed implementation guidance for each file and issue type.`,
  {label: 'Apply font fixes', phase: 'Fix'}
)

return {
  meta: meta,
  audit: auditReport,
  issues: issues.issues,
  analysis: analysisReport,
  fixes: fixes,
  status: 'complete'
}