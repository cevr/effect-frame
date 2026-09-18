import { MailboxStore } from "@effect-frame/actor";
import { mailboxStoreConformance } from "./mailbox-store.conformance";

mailboxStoreConformance("memory", MailboxStore.layerMemory);
