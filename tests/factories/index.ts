import { faker } from "@faker-js/faker";

faker.seed(42);

export {
  accountFactory,
  activeAccountFactory,
  disabledAccountFactory,
  errorAccountFactory,
} from "./accounts.js";
export { arbFlags, arbMessage, arbUidSet } from "./arbitraries.js";
export {
  archiveFactory,
  draftsFactory,
  folderFactory,
  inboxFactory,
  sentFactory,
  trashFactory,
} from "./folders.js";
export { messageFactory, seedAccountWithMessages } from "./messages.js";
export {
  emailWithAttachment,
  multipartHtmlEmail,
  nestedMultipartEmail,
  simplePlainEmail,
  unicodeHeaderEmail,
} from "./mime.js";
