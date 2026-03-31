import { faker } from "@faker-js/faker";

faker.seed(42);

export {
  accountFactory,
  activeAccountFactory,
  disabledAccountFactory,
  errorAccountFactory,
} from "./accounts.js";
export {
  folderFactory,
  inboxFactory,
  sentFactory,
  draftsFactory,
  trashFactory,
  archiveFactory,
} from "./folders.js";
export { messageFactory, seedAccountWithMessages } from "./messages.js";
export { arbUidSet, arbFlags, arbMessage } from "./arbitraries.js";
export {
  simplePlainEmail,
  multipartHtmlEmail,
  emailWithAttachment,
  nestedMultipartEmail,
  unicodeHeaderEmail,
} from "./mime.js";
