/**
 * Schwab multi-section (ToS Account Statement) CSV Parser Tests
 * Covers detectBrokerFormat detection branch + extractSchwabMultiSectionRecords
 * pre-processor introduced for v2.6.8-homelab.1.
 */

const fs = require('fs');
const path = require('path');

jest.mock('../../src/config/database', () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }));
jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../src/utils/finnhub', () => ({}));
jest.mock('../../src/utils/cache', () => ({ get: jest.fn().mockReturnValue(null), set: jest.fn(), del: jest.fn(), data: {} }));
jest.mock('../../src/utils/cusipQueue', () => ({ addToQueue: jest.fn() }));
jest.mock('../../src/utils/currencyConverter', () => ({
  convertTradeToUSD: jest.fn(trade => trade),
  userHasProAccess: jest.fn().mockResolvedValue(false)
}));

const {
  extractSchwabMultiSectionRecords,
  detectBrokerFormat,
} = require('../../src/utils/csvParser');

describe('Schwab multi-section CSV import', () => {
  const fixturePath = path.join(__dirname, '..', 'fixtures', 'schwab-account-statement-anonymized.csv');
  const fixture = fs.readFileSync(fixturePath);

  describe('detectBrokerFormat', () => {
    it('returns "thinkorswim-schwab-multisection" for multi-section files', () => {
      expect(detectBrokerFormat(fixture)).toBe('thinkorswim-schwab-multisection');
    });

    it('still returns "thinkorswim" for traditional single-section ToS files', () => {
      const traditional = Buffer.from(
        'DATE,TIME,TYPE,REF #,DESCRIPTION,Commissions & Fees,Misc Fees\n' +
          '01/15/2024,09:30:00,TRD,12345,"BOT +100 AAPL @150.25",1.00,0.00\n'
      );
      expect(detectBrokerFormat(traditional)).toBe('thinkorswim');
    });
  });

  describe('extractSchwabMultiSectionRecords', () => {
    const records = extractSchwabMultiSectionRecords(fixture);

    it('extracts exactly 11 records (10 futures + 1 synthetic AAPL)', () => {
      expect(records).toHaveLength(11);
    });

    it('emits only TRD rows (no BAL or FSWP)', () => {
      records.forEach((r) => expect(r.TYPE).toBe('TRD'));
    });

    it('strips Excel `="..."` wrappers from REF #', () => {
      records.forEach((r) => {
        expect(r['REF #']).not.toMatch(/^="/);
        expect(r['REF #']).not.toMatch(/"$/);
      });
    });

    it('normalizes `--` placeholders to empty strings in fee fields', () => {
      records.forEach((r) => {
        expect(r['Misc Fees']).not.toBe('--');
        expect(r['Commissions & Fees']).not.toBe('--');
      });
    });

    it('emits canonical column names regardless of source section', () => {
      const required = ['DATE', 'TIME', 'TYPE', 'REF #', 'DESCRIPTION', 'Commissions & Fees', 'Misc Fees'];
      records.forEach((r) => {
        required.forEach((k) => expect(r).toHaveProperty(k));
      });
    });

    it('extracts the synthetic AAPL equity trade from Cash Balance', () => {
      const equity = records.filter((r) => r.DESCRIPTION.includes('AAPL'));
      expect(equity).toHaveLength(1);
      expect(equity[0].DESCRIPTION).toMatch(/^BOT \+100 AAPL @180\.50$/);
    });

    it('extracts all 10 futures trades from Futures Statements', () => {
      const futures = records.filter((r) => /\/(ES|MES)M26:XCME/.test(r.DESCRIPTION));
      expect(futures).toHaveLength(10);
    });

    it('preserves negative-signed fees (Math.abs is applied downstream in the parser, not here)', () => {
      // Futures fees in the source are negative (e.g., -2.25). Our pre-processor
      // passes them through as-is; v2.6.8-homelab.1's Math.abs() in
      // parseThinkorswimTransactions handles the sign normalization.
      const futuresWithFees = records.filter((r) => r['Commissions & Fees'] && r['Commissions & Fees'].startsWith('-'));
      expect(futuresWithFees.length).toBeGreaterThan(0);
    });
  });

  describe('extractSchwabMultiSectionRecords against the canonical raw file (if available)', () => {
    const rawPath = '/Users/derekberger/Downloads/2026-05-22-AccountStatement.csv';
    const rawExists = fs.existsSync(rawPath);

    // Only runs on the operator's machine where the raw file lives. Skips
    // cleanly elsewhere (CI, other contributors) so the test suite stays green.
    (rawExists ? it : it.skip)('extracts exactly 10 TRD rows from the operator\'s real statement', () => {
      const recs = extractSchwabMultiSectionRecords(fs.readFileSync(rawPath));
      expect(recs).toHaveLength(10);
      // All trades in the real file are ES or MES futures
      const symbols = new Set(recs.map((r) => r.DESCRIPTION.match(/(\/\w+):XCME/)[1]));
      expect(symbols).toEqual(new Set(['/ESM26', '/MESM26']));
    });
  });
});
