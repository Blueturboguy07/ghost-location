import { AndroidAdapter } from '../../backend/android.mjs';

async function main() {
  const adapter = new AndroidAdapter({});
  const status = await adapter.status();
  console.log('adb status:', JSON.stringify(status));
  const list = await adapter.list();
  console.log('AndroidAdapter.list() ->', JSON.stringify(list, null, 1));
  if (list.length === 0) {
    console.log('BUGFIX_LAB_PRESENT');
    process.exit(1);
  } else {
    console.log('BUGFIX_LAB_ABSENT');
    process.exit(0);
  }
}

main().catch(error => {
  console.error('oracle-check threw:', error);
  console.log('BUGFIX_LAB_PRESENT');
  process.exit(1);
});
