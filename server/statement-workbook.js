const ExcelJS = require('exceljs');

const COLUMNS = [
  { header: 'Գործարքի ամսաթիվ', key: 'operationDate', width: 19, date: true },
  { header: 'Ստեղծման ամսաթիվ', key: 'creationDate', width: 22, date: true },
  { header: 'Ելք', key: 'debitAmount', width: 16, amount: true },
  { header: 'Ելք (AMD)', key: 'debitAmountAMD', width: 16, amount: true },
  { header: 'Մուտք', key: 'creditAmount', width: 16, amount: true },
  { header: 'Մուտք (AMD)', key: 'creditAmountAMD', width: 16, amount: true },
  { header: 'Նպատակ / մեկնաբանություն', key: 'comment', width: 55 },
  { header: 'Թղթակցող հաշիվ', key: 'correspondentAccount', width: 23, text: true },
  { header: 'Թղթակից', key: 'correspondentName', width: 34 },
  { header: 'Փոխանցման համար', key: 'transferNumber', width: 20, text: true },
  { header: 'Փոխանցման ID', key: 'transferId', width: 25, text: true },
  { header: 'Բանկային գործարքի ID', key: 'bankTransactionId', width: 23, text: true },
];

async function createStatementWorkbook({ transactions, accountNumber, dateFrom, dateTo }) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'MILON MINING LLC';
  workbook.created = new Date();
  workbook.modified = new Date();

  const sheet = workbook.addWorksheet('Քաղվածք', {
    views: [{ state: 'frozen', ySplit: 5, xSplit: 2, showGridLines: false }],
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });

  sheet.getCell('A2').value = 'Հաշվի քաղվածք';
  sheet.getCell('A2').font = { name: 'Arial', size: 16, bold: true, color: { argb: 'FF17365D' } };
  sheet.getCell('A3').value = 'Հաշվեհամար';
  sheet.getCell('B3').value = String(accountNumber);
  sheet.getCell('D3').value = 'Ժամանակահատված';
  sheet.getCell('E3').value = `${dateFrom.slice(0, 10)} - ${dateTo.slice(0, 10)}`;
  ['A3', 'D3'].forEach((address) => {
    sheet.getCell(address).font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FF666666' } };
  });
  ['B3', 'E3'].forEach((address) => {
    sheet.getCell(address).font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FF17365D' } };
  });

  const headerRowNumber = 5;
  const headerRow = sheet.getRow(headerRowNumber);
  COLUMNS.forEach((column, index) => {
    const cell = headerRow.getCell(index + 1);
    cell.value = column.header;
    sheet.getColumn(index + 1).width = column.width;
  });
  headerRow.height = 42;
  headerRow.eachCell((cell) => {
    cell.font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF17365D' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.border = { bottom: { style: 'medium', color: { argb: 'FF5B9BD5' } } };
  });

  for (const transaction of transactions) {
    const values = COLUMNS.map((column) => {
      const value = transaction[column.key];
      if (column.date && value) return new Date(value);
      if (column.text && value !== null && value !== undefined) return String(value);
      return value ?? '';
    });
    const row = sheet.addRow(values);
    row.height = 52;
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      const column = COLUMNS[colNumber - 1];
      cell.font = { name: 'Arial', size: 10, color: { argb: 'FF222222' } };
      cell.alignment = {
        vertical: 'top',
        horizontal: column.amount ? 'right' : column.date ? 'center' : 'left',
        wrapText: !column.amount && !column.date,
      };
      cell.border = { bottom: { style: 'hair', color: { argb: 'FFD9E2F3' } } };
      if (column.amount) cell.numFmt = '#,##0.00;[Red]-#,##0.00';
      if (column.date) cell.numFmt = 'dd.mm.yyyy hh:mm';
      if (row.number % 2 === 0) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF4F7FB' } };
    });
  }

  const firstDataRow = headerRowNumber + 1;
  const lastDataRow = Math.max(firstDataRow, sheet.rowCount);
  sheet.autoFilter = { from: { row: headerRowNumber, column: 1 }, to: { row: lastDataRow, column: COLUMNS.length } };

  const totalRow = sheet.addRow([]);
  totalRow.height = 28;
  totalRow.getCell(1).value = `Ընդամենը (${transactions.length} գործարք)`;
  totalRow.getCell(1).font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
  for (const col of [3, 4, 5, 6]) {
    const letter = sheet.getColumn(col).letter;
    totalRow.getCell(col).value = transactions.length ? { formula: `SUM(${letter}${firstDataRow}:${letter}${lastDataRow})` } : 0;
    totalRow.getCell(col).numFmt = '#,##0.00;[Red]-#,##0.00';
    totalRow.getCell(col).font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
  }
  for (let col = 1; col <= COLUMNS.length; col += 1) {
    totalRow.getCell(col).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };
    totalRow.getCell(col).alignment = { vertical: 'middle', horizontal: col >= 3 && col <= 6 ? 'right' : 'left' };
  }

  sheet.getColumn(8).numFmt = '@';
  sheet.getColumn(10).numFmt = '@';
  sheet.getColumn(11).numFmt = '@';
  sheet.getColumn(12).numFmt = '@';
  sheet.properties.defaultRowHeight = 18;
  sheet.pageSetup.printTitlesRow = '1:5';
  sheet.pageSetup.margins = { left: 0.25, right: 0.25, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 };

  return workbook.xlsx.writeBuffer();
}

module.exports = { createStatementWorkbook };
