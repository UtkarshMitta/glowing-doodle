import { getData } from '@/lib/data-loader';
import { SYSTEM_PROMPT } from '@/lib/system-prompt';
import {
  laborCost,
  overtimePremium,
  parseAffectedLines,
  parseBool,
  safeDivide,
  round,
} from '@/lib/calculations';
import type {
  DataStore,
  Contract,
  SOVLine,
  SOVBudget,
  LaborLog,
  MaterialDelivery,
  BillingHistory,
  BillingLineItem,
  ChangeOrder,
  RFI,
  FieldNote,
} from '@/lib/types';

// Route segment config for Vercel
export const maxDuration = 300;

// ── Gemini REST helpers ──

const GEMINI_MODEL = 'gemini-3-flash-preview';

function toGeminiContents(messages: { role: string; content: string }[]) {
  return messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
}

const TOOL_DECLARATIONS = [
  {
    name: 'scanPortfolio',
    description:
      'Scan ALL projects in the portfolio to compute health metrics, risk levels, margin analysis. ALWAYS call this FIRST.',
    parameters: { type: 'OBJECT' as const, properties: {}, required: [] },
  },
  {
    name: 'investigateProject',
    description: 'Deep dive into a specific project with SOV line-by-line variance analysis.',
    parameters: {
      type: 'OBJECT' as const,
      properties: {
        projectId: { type: 'STRING' as const, description: 'Project ID, e.g. PRJ-2024-001' },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'analyzeLaborDetails',
    description: 'Detailed labor analysis: breakdown by role, weekly trends, overtime analysis.',
    parameters: {
      type: 'OBJECT' as const,
      properties: {
        projectId: { type: 'STRING' as const, description: 'Project ID' },
        sovLineId: {
          type: 'STRING' as const,
          description: 'Optional: filter to a specific SOV line item',
        },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'checkBillingHealth',
    description:
      'Analyze billing status: payment history, per-line-item billing gaps, underbilled work.',
    parameters: {
      type: 'OBJECT' as const,
      properties: {
        projectId: { type: 'STRING' as const, description: 'Project ID' },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'reviewChangeOrders',
    description:
      'Review all change orders and RFIs. Identifies pending COs, aging, and RFIs with cost impact lacking COs.',
    parameters: {
      type: 'OBJECT' as const,
      properties: {
        projectId: { type: 'STRING' as const, description: 'Project ID' },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'searchFieldNotes',
    description: 'Search daily field notes for keywords like verbal, scope, additional, extra.',
    parameters: {
      type: 'OBJECT' as const,
      properties: {
        projectId: { type: 'STRING' as const, description: 'Project ID' },
        keywords: {
          type: 'ARRAY' as const,
          items: { type: 'STRING' as const },
          description: 'Keywords to search',
        },
      },
      required: ['projectId', 'keywords'],
    },
  },
  {
    name: 'sendEmailReport',
    description: 'Send a formatted HTML email report with findings and recommendations.',
    parameters: {
      type: 'OBJECT' as const,
      properties: {
        to: { type: 'STRING' as const, description: 'Recipient email address' },
        subject: { type: 'STRING' as const, description: 'Email subject line' },
        htmlBody: { type: 'STRING' as const, description: 'Email body in HTML format' },
      },
      required: ['to', 'subject', 'htmlBody'],
    },
  },
];

// ── Tool execute functions ──

function executeToolCall(
  name: string,
  args: Record<string, unknown>,
): unknown {
  const data = getData();

  switch (name) {
    case 'scanPortfolio':
      return executeScanPortfolio(data);
    case 'investigateProject':
      return executeInvestigateProject(data, args.projectId as string);
    case 'analyzeLaborDetails':
      return executeAnalyzeLaborDetails(
        data,
        args.projectId as string,
        args.sovLineId as string | undefined,
      );
    case 'checkBillingHealth':
      return executeCheckBillingHealth(data, args.projectId as string);
    case 'reviewChangeOrders':
      return executeReviewChangeOrders(data, args.projectId as string);
    case 'searchFieldNotes':
      return executeSearchFieldNotes(
        data,
        args.projectId as string,
        args.keywords as string[],
      );
    case 'sendEmailReport':
      return executeSendEmailReport(
        args.to as string,
        args.subject as string,
        args.htmlBody as string,
      );
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

function executeScanPortfolio(data: DataStore) {
  const projects = data.contracts.map((contract: Contract) => {
    const pid = contract.project_id;
    const budgets = data.sovBudget.filter((b: SOVBudget) => b.project_id === pid);
    const estimatedLaborCost = budgets.reduce((s, b) => s + (b.estimated_labor_cost || 0), 0);
    const estimatedMaterialCost = budgets.reduce((s, b) => s + (b.estimated_material_cost || 0), 0);
    const estimatedEquipmentCost = budgets.reduce(
      (s, b) => s + (b.estimated_equipment_cost || 0),
      0,
    );
    const estimatedSubCost = budgets.reduce((s, b) => s + (b.estimated_sub_cost || 0), 0);
    const estimatedTotalCost =
      estimatedLaborCost + estimatedMaterialCost + estimatedEquipmentCost + estimatedSubCost;
    const estimatedTotalHours = budgets.reduce((s, b) => s + (b.estimated_labor_hours || 0), 0);

    const laborLogs = data.laborLogs.filter((l: LaborLog) => l.project_id === pid);
    const actualLaborCost = round(laborLogs.reduce((s, l) => s + laborCost(l), 0), 0);
    const actualSTHours = laborLogs.reduce((s, l) => s + (l.hours_st || 0), 0);
    const actualOTHours = laborLogs.reduce((s, l) => s + (l.hours_ot || 0), 0);
    const totalActualHours = actualSTHours + actualOTHours;
    const otPremiumCost = round(laborLogs.reduce((s, l) => s + overtimePremium(l), 0), 0);

    const materials = data.materialDeliveries.filter(
      (m: MaterialDelivery) => m.project_id === pid,
    );
    const actualMaterialCost = round(
      materials.reduce((s, m) => s + (m.total_cost || 0), 0),
      0,
    );
    const costToDate = actualLaborCost + actualMaterialCost;

    const cos = data.changeOrders.filter((c: ChangeOrder) => c.project_id === pid);
    const approvedCOs = cos.filter((c) => c.status === 'Approved');
    const pendingCOs = cos.filter((c) => c.status === 'Pending');
    const approvedCOTotal = approvedCOs.reduce((s, c) => s + (c.amount || 0), 0);
    const pendingCOTotal = pendingCOs.reduce((s, c) => s + (c.amount || 0), 0);
    const adjustedContractValue = contract.original_contract_value + approvedCOTotal;

    const bidMarginPct = round(
      safeDivide(
        contract.original_contract_value - estimatedTotalCost,
        contract.original_contract_value,
      ) * 100,
      1,
    );
    const estimatedCostToComplete = Math.max(0, estimatedTotalCost - costToDate);
    const projectedTotalCost = costToDate + estimatedCostToComplete;
    const currentMarginPct = round(
      safeDivide(adjustedContractValue - projectedTotalCost, adjustedContractValue) * 100,
      1,
    );

    const billings = data.billingHistory.filter((b: BillingHistory) => b.project_id === pid);
    const latestBilling =
      billings.length > 0
        ? billings.reduce((max, b) => (b.application_number > max.application_number ? b : max))
        : null;
    const cumulativeBilled = latestBilling?.cumulative_billed || 0;
    const retentionHeld = latestBilling?.retention_held || 0;
    const billingLagDollars = costToDate - cumulativeBilled;

    const laborHoursVariancePct = round(
      safeDivide(totalActualHours - estimatedTotalHours, estimatedTotalHours) * 100,
      1,
    );
    const overtimePct = round(safeDivide(actualOTHours, totalActualHours) * 100, 1);

    const rfis = data.rfis.filter((r: RFI) => r.project_id === pid);
    const openRFIs = rfis.filter((r) => r.status !== 'Closed');
    const costImpactRFIs = rfis.filter((r) => parseBool(r.cost_impact));
    const rfiNumbersWithCO = cos
      .map((c) => c.related_rfi)
      .filter(Boolean);
    const unbilledRFIs = costImpactRFIs.filter(
      (r) => !rfiNumbersWithCO.includes(r.rfi_number),
    );

    const marginErosionPct =
      bidMarginPct > 0
        ? safeDivide(bidMarginPct - currentMarginPct, bidMarginPct) * 100
        : 0;
    let riskLevel: string;
    const topConcerns: string[] = [];

    if (marginErosionPct > 50 || laborHoursVariancePct > 25 || currentMarginPct < 5)
      riskLevel = 'CRITICAL';
    else if (
      laborHoursVariancePct > 10 ||
      overtimePct > 15 ||
      billingLagDollars > adjustedContractValue * 0.05
    )
      riskLevel = 'WATCH';
    else riskLevel = 'HEALTHY';

    if (laborHoursVariancePct > 10)
      topConcerns.push(`Labor hours ${laborHoursVariancePct}% over budget`);
    if (overtimePct > 15)
      topConcerns.push(
        `Overtime at ${overtimePct}% (premium cost: $${otPremiumCost.toLocaleString()})`,
      );
    if (billingLagDollars > 0)
      topConcerns.push(
        `$${billingLagDollars.toLocaleString()} in work completed but not yet billed`,
      );
    if (pendingCOTotal > 0)
      topConcerns.push(`$${pendingCOTotal.toLocaleString()} in pending change orders`);
    if (unbilledRFIs.length > 0)
      topConcerns.push(`${unbilledRFIs.length} RFIs with cost impact but no change order`);

    return {
      project_id: pid,
      project_name: contract.project_name,
      gc_name: contract.gc_name,
      completion_date: contract.substantial_completion_date,
      original_contract_value: contract.original_contract_value,
      approved_co_total: approvedCOTotal,
      pending_co_total: pendingCOTotal,
      adjusted_contract_value: adjustedContractValue,
      estimated_total_cost: estimatedTotalCost,
      cost_to_date: costToDate,
      actual_labor_cost: actualLaborCost,
      actual_material_cost: actualMaterialCost,
      bid_margin_pct: bidMarginPct,
      current_margin_pct: currentMarginPct,
      margin_erosion_pct: round(marginErosionPct, 1),
      cumulative_billed: cumulativeBilled,
      retention_held: retentionHeld,
      billing_lag_dollars: billingLagDollars,
      estimated_total_hours: estimatedTotalHours,
      actual_total_hours: totalActualHours,
      labor_hours_variance_pct: laborHoursVariancePct,
      overtime_pct: overtimePct,
      ot_premium_cost: otPremiumCost,
      open_rfi_count: openRFIs.length,
      rfis_with_cost_impact_no_co: unbilledRFIs.length,
      risk_level: riskLevel,
      top_concerns: topConcerns,
    };
  });

  const riskOrder: Record<string, number> = { CRITICAL: 0, WATCH: 1, HEALTHY: 2 };
  projects.sort((a, b) => riskOrder[a.risk_level] - riskOrder[b.risk_level]);

  return {
    portfolio_summary: {
      total_projects: projects.length,
      critical_count: projects.filter((p) => p.risk_level === 'CRITICAL').length,
      watch_count: projects.filter((p) => p.risk_level === 'WATCH').length,
      healthy_count: projects.filter((p) => p.risk_level === 'HEALTHY').length,
      total_contract_value: projects.reduce((s, p) => s + p.adjusted_contract_value, 0),
      total_cost_to_date: projects.reduce((s, p) => s + p.cost_to_date, 0),
      total_billed: projects.reduce((s, p) => s + p.cumulative_billed, 0),
      total_pending_co_exposure: projects.reduce((s, p) => s + p.pending_co_total, 0),
    },
    projects,
  };
}

function executeInvestigateProject(data: DataStore, projectId: string) {
  const contract = data.contracts.find((c: Contract) => c.project_id === projectId);
  if (!contract) return { error: `Project ${projectId} not found` };

  const sovLines = data.sov.filter((s: SOVLine) => s.project_id === projectId);
  const budgets = data.sovBudget.filter((b: SOVBudget) => b.project_id === projectId);

  const analysis = sovLines.map((sov: SOVLine) => {
    const budget = budgets.find((b) => b.sov_line_id === sov.sov_line_id);
    const logs = data.laborLogs.filter((l: LaborLog) => l.sov_line_id === sov.sov_line_id);
    const mats = data.materialDeliveries.filter(
      (m: MaterialDelivery) => m.sov_line_id === sov.sov_line_id,
    );
    const billingLines = data.billingLineItems.filter(
      (b: BillingLineItem) => b.sov_line_id === sov.sov_line_id,
    );
    const latestBilling =
      billingLines.length > 0
        ? billingLines.reduce((max, b) =>
            b.application_number > max.application_number ? b : max,
          )
        : null;

    const actualLaborHours = logs.reduce((s, l) => s + l.hours_st + l.hours_ot, 0);
    const actualLaborCostVal = round(logs.reduce((s, l) => s + laborCost(l), 0), 0);
    const actualMaterialCost = round(mats.reduce((s, m) => s + (m.total_cost || 0), 0), 0);
    const actualTotalCost = actualLaborCostVal + actualMaterialCost;

    const estLaborHours = budget?.estimated_labor_hours || 0;
    const estLaborCost = budget?.estimated_labor_cost || 0;
    const estMaterialCost = budget?.estimated_material_cost || 0;
    const estTotalCost =
      estLaborCost +
      estMaterialCost +
      (budget?.estimated_equipment_cost || 0) +
      (budget?.estimated_sub_cost || 0);

    const laborHoursVariance = actualLaborHours - estLaborHours;
    const laborHoursVariancePct = round(
      safeDivide(laborHoursVariance, estLaborHours) * 100,
      1,
    );
    const laborCostVariance = actualLaborCostVal - estLaborCost;
    const materialCostVariance = actualMaterialCost - estMaterialCost;
    const totalVariance = laborCostVariance + materialCostVariance;
    const pctBilled = latestBilling?.pct_complete || 0;
    const totalBilled = latestBilling?.total_billed || 0;

    let estimatedAtCompletion = estTotalCost;
    if (pctBilled > 5)
      estimatedAtCompletion = round(safeDivide(actualTotalCost, pctBilled / 100), 0);

    let status: string;
    if (laborHoursVariancePct > 30 || totalVariance > estTotalCost * 0.3) status = 'CRITICAL';
    else if (laborHoursVariancePct > 10 || totalVariance > estTotalCost * 0.1)
      status = 'OVERRUNNING';
    else status = 'ON_TRACK';

    return {
      sov_line_id: sov.sov_line_id,
      line_number: sov.line_number,
      description: sov.description,
      scheduled_value: sov.scheduled_value,
      estimated_total_cost: estTotalCost,
      actual_total_cost: actualTotalCost,
      labor_hours_variance_pct: laborHoursVariancePct,
      total_variance: totalVariance,
      pct_billed: pctBilled,
      total_billed: totalBilled,
      estimated_at_completion: estimatedAtCompletion,
      projected_overrun: estimatedAtCompletion - estTotalCost,
      status,
    };
  });

  analysis.sort((a, b) => b.total_variance - a.total_variance);
  return {
    project_id: projectId,
    project_name: contract.project_name,
    original_contract_value: contract.original_contract_value,
    total_sov_lines: analysis.length,
    lines_overrunning: analysis.filter((a) => a.status !== 'ON_TRACK').length,
    lines_critical: analysis.filter((a) => a.status === 'CRITICAL').length,
    total_variance: round(
      analysis.reduce((s, a) => s + a.total_variance, 0),
      0,
    ),
    sov_analysis: analysis,
  };
}

function executeAnalyzeLaborDetails(
  data: DataStore,
  projectId: string,
  sovLineId?: string,
) {
  let logs = data.laborLogs.filter((l: LaborLog) => l.project_id === projectId);
  if (sovLineId) logs = logs.filter((l) => l.sov_line_id === sovLineId);
  if (logs.length === 0) return { error: `No labor logs found for ${projectId}` };

  const roleMap = new Map<
    string,
    { headcount: Set<string>; stHrs: number; otHrs: number; cost: number }
  >();
  logs.forEach((l) => {
    const existing = roleMap.get(l.role) || {
      headcount: new Set<string>(),
      stHrs: 0,
      otHrs: 0,
      cost: 0,
    };
    existing.headcount.add(l.employee_id);
    existing.stHrs += l.hours_st || 0;
    existing.otHrs += l.hours_ot || 0;
    existing.cost += laborCost(l);
    roleMap.set(l.role, existing);
  });

  const byRole = Array.from(roleMap.entries())
    .map(([role, d]) => ({
      role,
      headcount: d.headcount.size,
      total_st_hours: round(d.stHrs, 1),
      total_ot_hours: round(d.otHrs, 1),
      total_cost: round(d.cost, 0),
    }))
    .sort((a, b) => b.total_cost - a.total_cost);

  const totalST = logs.reduce((s, l) => s + (l.hours_st || 0), 0);
  const totalOT = logs.reduce((s, l) => s + (l.hours_ot || 0), 0);
  const otPremium = round(logs.reduce((s, l) => s + overtimePremium(l), 0), 0);

  return {
    project_id: projectId,
    sov_filter: sovLineId || 'ALL',
    total_records: logs.length,
    by_role: byRole,
    overtime_analysis: {
      total_st_hours: round(totalST, 1),
      total_ot_hours: round(totalOT, 1),
      ot_percentage: round(safeDivide(totalOT, totalST + totalOT) * 100, 1),
      ot_premium_cost: otPremium,
    },
  };
}

function executeCheckBillingHealth(data: DataStore, projectId: string) {
  const contract = data.contracts.find((c: Contract) => c.project_id === projectId);
  if (!contract) return { error: `Project ${projectId} not found` };

  const billings = data.billingHistory
    .filter((b: BillingHistory) => b.project_id === projectId)
    .sort((a, b) => a.application_number - b.application_number);

  const allBillingLines = data.billingLineItems.filter(
    (b: BillingLineItem) => b.project_id === projectId,
  );
  const maxApp =
    allBillingLines.length > 0
      ? Math.max(...allBillingLines.map((b) => b.application_number))
      : 0;
  const latestLines = allBillingLines.filter((b) => b.application_number === maxApp);
  const sovLines = data.sov.filter((s: SOVLine) => s.project_id === projectId);
  const budgetsForProject = data.sovBudget.filter(
    (b: SOVBudget) => b.project_id === projectId,
  );

  const lineHealth = sovLines.map((sov: SOVLine) => {
    const billing = latestLines.find((b) => b.sov_line_id === sov.sov_line_id);
    const budget = budgetsForProject.find((b) => b.sov_line_id === sov.sov_line_id);
    const logs = data.laborLogs.filter(
      (l: LaborLog) => l.sov_line_id === sov.sov_line_id,
    );
    const mats = data.materialDeliveries.filter(
      (m: MaterialDelivery) => m.sov_line_id === sov.sov_line_id,
    );

    const actualCost = round(
      logs.reduce((s, l) => s + laborCost(l), 0) +
        mats.reduce((s, m) => s + (m.total_cost || 0), 0),
      0,
    );

    const estTotalCost = budget
      ? budget.estimated_labor_cost +
        budget.estimated_material_cost +
        budget.estimated_equipment_cost +
        budget.estimated_sub_cost
      : sov.scheduled_value;

    const costPct = round(safeDivide(actualCost, estTotalCost) * 100, 1);
    const pctBilled = billing?.pct_complete || 0;
    const billingGapPct = round(costPct - pctBilled, 1);
    const billingGapDollars = round((billingGapPct / 100) * sov.scheduled_value, 0);

    let status: string;
    if (billingGapPct > 10) status = 'UNDERBILLED';
    else if (billingGapPct < -10) status = 'OVERBILLED';
    else status = 'ON_TRACK';

    return {
      sov_line_id: sov.sov_line_id,
      description: sov.description,
      scheduled_value: sov.scheduled_value,
      pct_billed: pctBilled,
      cost_based_pct: costPct,
      billing_gap_pct: billingGapPct,
      billing_gap_dollars: billingGapDollars,
      status,
    };
  });

  lineHealth.sort((a, b) => b.billing_gap_dollars - a.billing_gap_dollars);
  const totalUnderbilled = lineHealth
    .filter((l) => l.status === 'UNDERBILLED')
    .reduce((s, l) => s + l.billing_gap_dollars, 0);

  return {
    project_id: projectId,
    billing_history: billings.length,
    line_item_health: lineHealth,
    summary: {
      contract_value: contract.original_contract_value,
      total_underbilled: round(totalUnderbilled, 0),
      lines_underbilled: lineHealth.filter((l) => l.status === 'UNDERBILLED').length,
    },
  };
}

function executeReviewChangeOrders(data: DataStore, projectId: string) {
  const cos = data.changeOrders.filter((c: ChangeOrder) => c.project_id === projectId);
  const rfis = data.rfis.filter((r: RFI) => r.project_id === projectId);
  const today = new Date();

  const changeOrders = cos.map((co: ChangeOrder) => {
    const daysPending =
      co.status === 'Pending'
        ? Math.floor(
            (today.getTime() - new Date(co.date_submitted).getTime()) / 86400000,
          )
        : null;
    return {
      co_number: co.co_number,
      reason_category: co.reason_category,
      description: co.description,
      amount: co.amount,
      status: co.status,
      related_rfi: co.related_rfi || null,
      affected_sov_lines: parseAffectedLines(co.affected_sov_lines),
      days_pending: daysPending,
      aging_flag:
        daysPending && daysPending > 21
          ? 'OVERDUE'
          : daysPending
            ? 'PENDING'
            : null,
    };
  });

  const rfiNumbersWithCO = new Set(
    cos.map((c) => c.related_rfi).filter(Boolean),
  );
  const rfiAnalysis = rfis.map((rfi: RFI) => {
    const hasCostImpact = parseBool(rfi.cost_impact);
    const hasCorrespondingCO = rfiNumbersWithCO.has(rfi.rfi_number);
    return {
      rfi_number: rfi.rfi_number,
      subject: rfi.subject,
      priority: rfi.priority,
      status: rfi.status,
      cost_impact: hasCostImpact,
      has_corresponding_co: hasCorrespondingCO,
      unbilled_flag:
        hasCostImpact && !hasCorrespondingCO ? 'UNBILLED_EXPOSURE' : null,
    };
  });

  const approved = changeOrders.filter((c) => c.status === 'Approved');
  const pending = changeOrders.filter((c) => c.status === 'Pending');
  const unbilledRFIs = rfiAnalysis.filter(
    (r) => r.unbilled_flag === 'UNBILLED_EXPOSURE',
  );

  return {
    project_id: projectId,
    change_orders: changeOrders,
    rfis: rfiAnalysis,
    summary: {
      approved_count: approved.length,
      approved_total: approved.reduce((s, c) => s + c.amount, 0),
      pending_count: pending.length,
      pending_total: pending.reduce((s, c) => s + c.amount, 0),
      overdue_pending: pending.filter((c) => c.aging_flag === 'OVERDUE').length,
      rfis_with_cost_impact_no_co: unbilledRFIs.length,
      unbilled_rfi_subjects: unbilledRFIs.map(
        (r) => `${r.rfi_number}: ${r.subject}`,
      ),
    },
  };
}

function executeSearchFieldNotes(
  data: DataStore,
  projectId: string,
  keywords: string[],
) {
  const notes = data.fieldNotes.filter(
    (n: FieldNote) => n.project_id === projectId,
  );
  const matches = notes
    .map((note: FieldNote) => {
      const contentLower = String(note.content ?? '').toLowerCase();
      const matchedKeywords = keywords.filter((kw) =>
        contentLower.includes(kw.toLowerCase()),
      );
      if (matchedKeywords.length === 0) return null;
      return {
        note_id: note.note_id,
        date: note.date,
        author: note.author,
        note_type: note.note_type,
        content: note.content,
        matched_keywords: matchedKeywords,
      };
    })
    .filter(
      (
        n,
      ): n is {
        note_id: string;
        date: string;
        author: string;
        note_type: string;
        content: string;
        matched_keywords: string[];
      } => n !== null,
    )
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, 25);

  return {
    project_id: projectId,
    search_terms: keywords,
    total_notes_searched: notes.length,
    total_matches: matches.length,
    matches,
  };
}

async function executeSendEmailReport(
  to: string,
  subject: string,
  htmlBody: string,
) {
  const webhookUrl = process.env.GAS_EMAIL_WEBHOOK_URL;
  const defaultRecipient = process.env.ALERT_EMAIL_TO;

  if (!webhookUrl) {
    return {
      success: false,
      message:
        'Email system not configured. Set GAS_EMAIL_WEBHOOK_URL environment variable and restart the server.',
    };
  }

  const recipient = to || defaultRecipient || 'team@example.com';

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: recipient, subject, body: htmlBody }),
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`HTTP ${res.status}: ${errorText}`);
    }

    const result = await res.json();
    return { success: true, message: `Email sent to ${recipient}`, result };
  } catch (error: unknown) {
    return {
      success: false,
      message: `Email failed: ${error instanceof Error ? error.message : String(error)}. Check that your Google Apps Script is deployed correctly.`,
    };
  }
}

// ── Main POST handler ──

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: unknown };
}

interface GeminiContent {
  role: string;
  parts: GeminiPart[];
}

export async function POST(req: Request) {
  const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: 'GOOGLE_GENERATIVE_AI_API_KEY is not set. Add it in the Vars sidebar.' },
      { status: 500 },
    );
  }

  const { messages } = await req.json();
  const geminiContents = toGeminiContents(messages);

  const conversationContents: GeminiContent[] = [
    { role: 'user', parts: [{ text: SYSTEM_PROMPT }] },
    {
      role: 'model',
      parts: [
        {
          text: 'Understood. I am MarginGuard AI, ready to autonomously protect HVAC contractor margins. I will chain multiple tools and provide specific dollar amounts with every finding.',
        },
      ],
    },
    ...geminiContents,
  ];

  const MAX_TOOL_ROUNDS = 12;
  let toolRound = 0;
  let streamingStarted = false;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        while (toolRound < MAX_TOOL_ROUNDS) {
          toolRound++;

          const isToolRound = toolRound < MAX_TOOL_ROUNDS;
          const url = isToolRound
            ? `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`
            : `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:streamGenerateContent?alt=sse&key=${apiKey}`;

          const body = {
            contents: conversationContents,
            tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
            generationConfig: {
              temperature: 0.2,
              maxOutputTokens: 8192,
            },
          };

          const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });

          if (!res.ok) {
            const errText = await res.text();
            controller.enqueue(
              encoder.encode(`Error from Gemini API (${res.status}): ${errText}`),
            );
            controller.close();
            return;
          }

          if (isToolRound) {
            const json = await res.json();
            const candidate = json.candidates?.[0];
            if (!candidate) {
              controller.enqueue(encoder.encode('No response from Gemini.'));
              controller.close();
              return;
            }

            const parts: GeminiPart[] = candidate.content?.parts || [];
            const functionCalls = parts.filter(
              (p): p is GeminiPart & { functionCall: { name: string; args: Record<string, unknown> } } =>
                !!p.functionCall,
            );

            if (functionCalls.length === 0) {
              const textParts = parts
                .filter((p): p is GeminiPart & { text: string } => !!p.text)
                .map((p) => p.text);
              const finalText = textParts.join('');

              const words = finalText.split(' ');
              for (let i = 0; i < words.length; i++) {
                const chunk = (i === 0 ? '' : ' ') + words[i];
                controller.enqueue(encoder.encode(chunk));
                await new Promise((r) => setTimeout(r, 15));
              }

              controller.close();
              return;
            }

            const functionResponseParts: GeminiPart[] = [];
            for (const part of functionCalls) {
              const { name, args } = part.functionCall;

              if (!streamingStarted) {
                streamingStarted = true;
              }
              const toolStatus = `[Calling tool: ${name}...]\n`;
              controller.enqueue(encoder.encode(toolStatus));

              const result =
                name === 'sendEmailReport'
                  ? await executeToolCall(name, args || {})
                  : executeToolCall(name, args || {});

              functionResponseParts.push({
                functionResponse: { name, response: result },
              });
            }

            conversationContents.push({
              role: 'model',
              parts: functionCalls as GeminiPart[],
            });
            conversationContents.push({
              role: 'user',
              parts: functionResponseParts,
            });
          } else {
            const reader = res.body?.getReader();
            if (!reader) {
              controller.enqueue(encoder.encode('Failed to read streaming response.'));
              controller.close();
              return;
            }

            const decoder = new TextDecoder();
            let buffer = '';

            while (true) {
              const { done, value } = await reader.read();
              if (done) break;

              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split('\n');
              buffer = lines.pop() || '';

              for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const jsonStr = line.slice(6).trim();
                if (!jsonStr || jsonStr === '[DONE]') continue;

                try {
                  const parsed = JSON.parse(jsonStr);
                  const sParts: GeminiPart[] =
                    parsed.candidates?.[0]?.content?.parts || [];

                  const fCalls = sParts.filter(
                    (p): p is GeminiPart & { functionCall: { name: string; args: Record<string, unknown> } } =>
                      !!p.functionCall,
                  );
                  if (fCalls.length > 0) {
                    const fResponseParts: GeminiPart[] = [];
                    for (const part of fCalls) {
                      const { name, args } = part.functionCall;
                      controller.enqueue(
                        encoder.encode(`[Calling tool: ${name}...]\n`),
                      );
                      const result =
                        name === 'sendEmailReport'
                          ? await executeToolCall(name, args || {})
                          : executeToolCall(name, args || {});
                      fResponseParts.push({
                        functionResponse: { name, response: result },
                      });
                    }
                    conversationContents.push({
                      role: 'model',
                      parts: fCalls as GeminiPart[],
                    });
                    conversationContents.push({
                      role: 'user',
                      parts: fResponseParts,
                    });
                    break;
                  }

                  for (const part of sParts) {
                    if (part.text) {
                      controller.enqueue(encoder.encode(part.text));
                    }
                  }
                } catch {
                  // Skip unparseable chunks
                }
              }
            }

            controller.close();
            return;
          }
        }

        controller.enqueue(
          encoder.encode('\n\n(Reached maximum tool execution rounds)'),
        );
        controller.close();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        controller.enqueue(encoder.encode(`\n\nError: ${msg}`));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Transfer-Encoding': 'chunked',
      'Cache-Control': 'no-cache',
    },
  });
}
