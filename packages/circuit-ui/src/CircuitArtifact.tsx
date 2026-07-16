import Ajv from "ajv";
import { useEffect, useMemo, useState } from "react";
import type { ArtifactRendererProps } from "silverretort-chat-ui";
import Circuit from "./circuit";
import { DEFAULT_CIRCUIT, normalizeCircuitData } from "./defaults";
import circuitDataSchema from "./generated/circuit-data.schema.json";
import type { CircuitData } from "./types";

const validateCircuitData = new Ajv({ allErrors: true, strict: false }).compile<CircuitData>(
  circuitDataSchema,
);

function toCircuitData(payload: unknown): CircuitData {
  return validateCircuitData(payload)
    ? normalizeCircuitData(payload)
    : DEFAULT_CIRCUIT;
}

export function CircuitArtifact({ artifact }: ArtifactRendererProps) {
  const initialData = useMemo(
    () => toCircuitData(artifact.payload),
    [artifact.payload],
  );
  const [data, setData] = useState(initialData);

  useEffect(() => {
    setData(initialData);
  }, [artifact.id, initialData]);

  return <Circuit data={data} onChange={setData} />;
}
