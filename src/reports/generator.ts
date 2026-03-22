/**
 * Report Generator — PDF and Excel statements for personal and group wallets.
 *
 * Queries service_receipts and group_transactions, then generates
 * downloadable PDF (pdfkit) or XLSX (exceljs) reports.
 */

import PDFDocument from 'pdfkit';
import ExcelJS from 'exceljs';
import { getReceiptsByDateRange, ServiceReceipt } from '../blockchain/service-receipts';
import { getGroupTransactions, getGroup, GroupTransaction } from '../bot/groups';

// ─── Types ───────────────────────────────────────────────────

export interface ReportOptions {
  walletAddress: string;        // Payer address to filter receipts
  startDate?: Date;
  endDate?: Date;
  format: 'pdf' | 'xlsx';
  title?: string;               // "Personal Statement" or "Group: Team Name"
  groupId?: string;             // If set, include group transactions too
}

export interface ReportResult {
  buffer: Buffer;
  filename: string;
  mimeType: string;
}

// ─── PDF Generation ──────────────────────────────────────────

function generatePdf(
  receipts: ServiceReceipt[],
  groupTxs: GroupTransaction[],
  options: ReportOptions,
): Buffer {
  const doc = new PDFDocument({ margin: 40, size: 'A4' });
  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));

  const title = options.title || 'Transaction Statement';
  const dateRange = formatDateRange(options.startDate, options.endDate);

  // Header
  doc.fontSize(18).text('Toppa', { align: 'center' });
  doc.fontSize(10).fillColor('#666').text('Airtime, Data, Bills & Gift Cards on Celo', { align: 'center' });
  doc.moveDown(0.5);
  doc.fontSize(14).fillColor('#000').text(title, { align: 'center' });
  doc.fontSize(9).fillColor('#666').text(dateRange, { align: 'center' });
  doc.moveDown(0.3);
  doc.fontSize(8).text(`Wallet: ${options.walletAddress}`, { align: 'center' });
  doc.moveDown(0.3);
  doc.fontSize(8).text(`Generated: ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`, { align: 'center' });
  doc.moveDown(1);

  // Summary
  const totalSpent = receipts
    .filter(r => r.status === 'success')
    .reduce((sum, r) => sum + parseFloat(r.paymentAmount || '0'), 0);
  const byType: Record<string, number> = {};
  for (const r of receipts.filter(r => r.status === 'success')) {
    byType[r.serviceType] = (byType[r.serviceType] || 0) + parseFloat(r.paymentAmount || '0');
  }

  doc.fontSize(12).fillColor('#000').text('Summary');
  doc.moveTo(40, doc.y).lineTo(555, doc.y).stroke('#ccc');
  doc.moveDown(0.3);
  doc.fontSize(9);
  doc.text(`Total Transactions: ${receipts.length}`);
  doc.text(`Successful: ${receipts.filter(r => r.status === 'success').length}`);
  doc.text(`Total Spent: ${totalSpent.toFixed(2)} cUSD`);
  doc.moveDown(0.3);
  for (const [type, amount] of Object.entries(byType)) {
    const label = type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    doc.text(`  ${label}: ${amount.toFixed(2)} cUSD`);
  }
  doc.moveDown(1);

  // Transactions table
  doc.fontSize(12).fillColor('#000').text('Transactions');
  doc.moveTo(40, doc.y).lineTo(555, doc.y).stroke('#ccc');
  doc.moveDown(0.5);

  if (receipts.length === 0) {
    doc.fontSize(9).fillColor('#666').text('No transactions found for this period.');
  } else {
    // Table header
    const colX = [40, 110, 175, 305, 380, 430];
    doc.fontSize(8).fillColor('#333');
    doc.text('Date', colX[0], doc.y, { width: 65 });
    doc.text('Type', colX[1], doc.y - doc.currentLineHeight(), { width: 60 });
    doc.text('Description', colX[2], doc.y - doc.currentLineHeight(), { width: 125 });
    doc.text('Amount', colX[3], doc.y - doc.currentLineHeight(), { width: 50 });
    doc.text('Status', colX[4], doc.y - doc.currentLineHeight(), { width: 45 });
    doc.text('TX Hash', colX[5], doc.y - doc.currentLineHeight(), { width: 120 });
    doc.moveDown(0.5);
    doc.moveTo(40, doc.y).lineTo(555, doc.y).stroke('#eee');

    for (const r of receipts) {
      if (doc.y > 750) {
        doc.addPage();
      }
      const y = doc.y + 3;
      const date = r.createdAt ? new Date(r.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '-';
      const type = r.serviceType.replace(/_/g, ' ').slice(0, 12);
      const desc = formatReceiptDescription(r).slice(0, 30);
      const amount = `${parseFloat(r.paymentAmount || '0').toFixed(2)}`;
      const status = r.status;
      const txHash = r.paymentTxHash ? `${r.paymentTxHash.slice(0, 10)}...` : '-';

      doc.fontSize(7).fillColor('#000');
      doc.text(date, colX[0], y, { width: 65 });
      doc.text(type, colX[1], y, { width: 60 });
      doc.text(desc, colX[2], y, { width: 125 });
      doc.text(amount, colX[3], y, { width: 50 });
      doc.fillColor(status === 'success' ? '#2a7' : '#c44').text(status, colX[4], y, { width: 45 });
      doc.fillColor('#666').text(txHash, colX[5], y, { width: 120 });
      doc.moveDown(0.3);
    }
  }

  // Group transactions section
  if (groupTxs.length > 0) {
    doc.moveDown(1);
    doc.fontSize(12).fillColor('#000').text('Group Transactions');
    doc.moveTo(40, doc.y).lineTo(555, doc.y).stroke('#ccc');
    doc.moveDown(0.5);

    for (const tx of groupTxs) {
      if (doc.y > 750) doc.addPage();
      const date = tx.createdAt ? new Date(tx.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '-';
      doc.fontSize(8).fillColor('#000');
      doc.text(`${date}  |  ${tx.type}  |  ${tx.amount.toFixed(2)} cUSD  |  ${tx.description}`, 40);
    }
  }

  // Footer
  doc.moveDown(2);
  doc.fontSize(7).fillColor('#999').text('This statement was generated by Toppa. All amounts in cUSD on the Celo network.', { align: 'center' });

  doc.end();
  return Buffer.concat(chunks);
}

// ─── Excel Generation ────────────────────────────────────────

async function generateExcel(
  receipts: ServiceReceipt[],
  groupTxs: GroupTransaction[],
  options: ReportOptions,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Toppa';
  workbook.created = new Date();

  // ── Transactions Sheet ──
  const txSheet = workbook.addWorksheet('Transactions');
  txSheet.columns = [
    { header: 'Date', key: 'date', width: 14 },
    { header: 'Type', key: 'type', width: 14 },
    { header: 'Description', key: 'description', width: 35 },
    { header: 'Amount (cUSD)', key: 'amount', width: 14 },
    { header: 'Status', key: 'status', width: 10 },
    { header: 'Source', key: 'source', width: 10 },
    { header: 'TX Hash', key: 'txHash', width: 50 },
  ];

  // Style header row
  txSheet.getRow(1).font = { bold: true };
  txSheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8E8E8' } };

  for (const r of receipts) {
    txSheet.addRow({
      date: r.createdAt ? new Date(r.createdAt).toLocaleDateString('en-US') : '-',
      type: r.serviceType.replace(/_/g, ' '),
      description: formatReceiptDescription(r),
      amount: parseFloat(r.paymentAmount || '0'),
      status: r.status,
      source: r.source,
      txHash: r.paymentTxHash || '-',
    });
  }

  // ── Summary Sheet ──
  const summarySheet = workbook.addWorksheet('Summary');
  summarySheet.columns = [
    { header: 'Metric', key: 'metric', width: 25 },
    { header: 'Value', key: 'value', width: 20 },
  ];
  summarySheet.getRow(1).font = { bold: true };

  const successReceipts = receipts.filter(r => r.status === 'success');
  const totalSpent = successReceipts.reduce((sum, r) => sum + parseFloat(r.paymentAmount || '0'), 0);

  summarySheet.addRow({ metric: 'Report Title', value: options.title || 'Transaction Statement' });
  summarySheet.addRow({ metric: 'Date Range', value: formatDateRange(options.startDate, options.endDate) });
  summarySheet.addRow({ metric: 'Wallet Address', value: options.walletAddress });
  summarySheet.addRow({ metric: 'Total Transactions', value: receipts.length });
  summarySheet.addRow({ metric: 'Successful', value: successReceipts.length });
  summarySheet.addRow({ metric: 'Failed', value: receipts.filter(r => r.status === 'failed').length });
  summarySheet.addRow({ metric: 'Total Spent (cUSD)', value: totalSpent.toFixed(2) });

  // By-type breakdown
  const byType: Record<string, number> = {};
  for (const r of successReceipts) {
    byType[r.serviceType] = (byType[r.serviceType] || 0) + parseFloat(r.paymentAmount || '0');
  }
  for (const [type, amount] of Object.entries(byType)) {
    summarySheet.addRow({
      metric: `  ${type.replace(/_/g, ' ')}`,
      value: amount.toFixed(2),
    });
  }

  // ── Group Transactions Sheet (if applicable) ──
  if (groupTxs.length > 0) {
    const groupSheet = workbook.addWorksheet('Group Transactions');
    groupSheet.columns = [
      { header: 'Date', key: 'date', width: 14 },
      { header: 'Type', key: 'type', width: 14 },
      { header: 'User', key: 'user', width: 20 },
      { header: 'Amount (cUSD)', key: 'amount', width: 14 },
      { header: 'Description', key: 'description', width: 35 },
      { header: 'TX Hash', key: 'txHash', width: 50 },
    ];
    groupSheet.getRow(1).font = { bold: true };
    groupSheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8E8E8' } };

    for (const tx of groupTxs) {
      groupSheet.addRow({
        date: tx.createdAt ? new Date(tx.createdAt).toLocaleDateString('en-US') : '-',
        type: tx.type,
        user: tx.userId,
        amount: tx.amount,
        description: tx.description,
        txHash: tx.txHash,
      });
    }
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

// ─── Helpers ─────────────────────────────────────────────────

function formatDateRange(startDate?: Date, endDate?: Date): string {
  const fmt = (d: Date) => d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  if (startDate && endDate) return `${fmt(startDate)} — ${fmt(endDate)}`;
  if (startDate) return `From ${fmt(startDate)}`;
  if (endDate) return `Until ${fmt(endDate)}`;
  return 'All time';
}

function formatReceiptDescription(r: ServiceReceipt): string {
  const args = r.serviceArgs || {};
  const phone = args.phone || args.toolArgs?.phone;
  const email = args.recipientEmail || args.toolArgs?.recipientEmail;

  switch (r.serviceType) {
    case 'airtime':
      return phone ? `Airtime to ${phone}` : 'Airtime top-up';
    case 'data':
      return phone ? `Data to ${phone}` : 'Data bundle';
    case 'bill_payment':
      return args.accountNumber ? `Bill #${args.accountNumber}` : 'Bill payment';
    case 'gift_card':
      return email ? `Gift card to ${email}` : 'Gift card purchase';
    default:
      return r.serviceType;
  }
}

// ─── Main Entry Point ────────────────────────────────────────

/**
 * Generate a transaction statement report.
 */
export async function generateReport(options: ReportOptions): Promise<ReportResult> {
  // Fetch personal receipts
  const receipts = await getReceiptsByDateRange(
    options.walletAddress,
    options.startDate,
    options.endDate,
  );

  // Fetch group transactions if applicable
  let groupTxs: GroupTransaction[] = [];
  if (options.groupId) {
    const group = await getGroup(options.groupId);
    if (group) {
      const allGroupTxs = await getGroupTransactions(options.groupId, 500);
      // Filter by date range
      groupTxs = allGroupTxs.filter(tx => {
        if (options.startDate && tx.createdAt < options.startDate) return false;
        if (options.endDate && tx.createdAt > options.endDate) return false;
        return true;
      });
    }
  }

  const dateStr = new Date().toISOString().slice(0, 10);
  const titleSlug = (options.title || 'statement').replace(/\s+/g, '-').toLowerCase();

  if (options.format === 'xlsx') {
    const buffer = await generateExcel(receipts, groupTxs, options);
    return {
      buffer,
      filename: `toppa-${titleSlug}-${dateStr}.xlsx`,
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    };
  }

  const buffer = generatePdf(receipts, groupTxs, options);
  return {
    buffer,
    filename: `toppa-${titleSlug}-${dateStr}.pdf`,
    mimeType: 'application/pdf',
  };
}
