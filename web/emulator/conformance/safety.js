// A passing damage detector is unsafe; ordinary conformance passes are not.
export function criticalStop(report) {
  const tests = report?.results?.filter(row =>
    row.severity === 'critical' && row.unsafeWhen === 'pass' && row.status === 'pass');
  if (!tests?.length) return null;
  return {
    reason: 'critical-conformance-pass',
    imageSha256: report.imageSha256,
    tests,
    message: report.warning || `Emulator terminated: critical test ${tests.map(row => row.id).join(', ')} passed, indicating behavior that could damage a hardware device. Do not flash this firmware to a real device.`,
  };
}
