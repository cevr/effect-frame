import { MailboxStore } from "@effect-frame/actor";
import { mailboxStoreConformanceLayer } from "./mailbox-store.conformance";

mailboxStoreConformanceLayer("memory", MailboxStore.layerMemory);
