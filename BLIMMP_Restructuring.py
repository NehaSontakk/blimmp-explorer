# -*- coding: utf-8 -*-

import os
import glob
import pandas as pd
import numpy as np
from math import exp
import json
import argparse
import re, math

KO_RE = re.compile(r'^K\d{5}$')

#Process HMMER output
class Read_HMMER_Files:
    HMMER_COLS = [
        'target name', 'target_accession', 'tlen', 'query_name',
        'query_accession', 'qlen', 'full_Evalue', 'full_score',
        'full_bias', 'n_domains', 'of_domains', 'c_Evalue',
        'i_Evalue', 'i_score', 'i_bias', 'hmm from', 'hmm to',
        'ali from', 'ali to', 'env from', 'env to', 'acc', 'description'
    ]

    #Process HMM result files                       
    def read_domtblout(path):
        print("Processing HMMER file ...")

        df = pd.read_csv(path,comment='#', sep=r'\s+', names=Read_HMMER_Files.HMMER_COLS,usecols=['target name','query_name','hmm from','hmm to','ali from','ali to','i_score','i_Evalue'],engine='python')
        # Decide which column is KO-like: ^K\d{5}$
        q_matches = df['query_name'].astype(str).str.fullmatch(KO_RE.pattern, na=False)
        t_matches = df['target name'].astype(str).str.fullmatch(KO_RE.pattern, na=False)
        fq = q_matches.mean()
        ft = t_matches.mean() 
        if (fq > 0 or ft > 0) and (fq >= ft):
            # query_name looks more like KO IDs
            df = df.rename(columns={'query_name': 'KO id', 'target name': 'target name'})
        elif ft > 0:
            # target name looks more like KO IDs
            df = df.rename(columns={'target name': 'KO id', 'query_name': 'target name'})
        else:
            print("Error: Can't read the KO ids.")

        #Rename Columns
        df = df.rename(columns={'i_score': 'score', 'i_Evalue': 'E-value'})
        # Compute alignment/hmm lengths and filter zero-length hits
        df['ali_len'] = (df['ali to'] - df['ali from']).abs()
        df['hmm_len'] = (df['hmm to'] - df['hmm from']).abs()
        df = df[(df['ali_len'] > 0) & (df['hmm_len'] > 0)].copy()
        # Drop helper cols
        df.drop(columns=['ali_len', 'hmm_len'], inplace=True)
        
        print(df.head())
        return df             

class Group_Overlapping_Annotations:

    def cluster_strand(df, from_col="ali from", to_col="ali to"):
        # normalize & sort
        df = df.copy()
        df["start"] = df[[from_col,to_col]].min(axis=1)
        df["end"]   = df[[from_col,to_col]].max(axis=1)
        df = df.sort_values("start").reset_index()

        groups = [] # each group: {"id": int, "end": float}
        grp_ids = []      

        for _, row in df.iterrows():
            s,e = row["start"], row["end"]
            length = abs(s-e)
            for grp in groups:
                if s <= grp["end"]:
                    overlap = max(0, min(e, grp["end"]) - max(s, grp["start"]))
                    short_len = min(e - s, grp["end"] - grp["start"])
                    frac = overlap / short_len
                    #print(frac, overlap)
                    #print("row",s,e)
                    #print("grp",grp["start"],grp["end"])
                    if frac >= 0.6:
                        grp_ids.append(grp["id"])
                        grp["start"] = min(grp["start"], s)
                        grp["end"]   = max(grp["end"],   e)
                        break
            else:
                new_id = len(groups) + 1
                groups.append({"id": new_id, "start":s ,"end": e})
                grp_ids.append(new_id)
        df["grp_id"] = grp_ids
        return df.set_index("index").sort_index()[["grp_id"]]

    def assign_overlap_groups(df_hits):
        # strand column
        df = df_hits.copy()
        df["strand"] = np.where(df["ali to"] >= df["ali from"], "+", "-")

        #per‐target, per‐strand clustering
        out = []
        for (tgt, strand), sub in df.groupby(["target name","strand"], sort=False):
            clustered = Group_Overlapping_Annotations.cluster_strand(sub)
            # merge grp_id back onto sub
            sub = sub.join(clustered, how="left")
            out.append(sub)

        #combine all targets & strands
        result = pd.concat(out).sort_index()
        result["overlap_group"] = (result["target name"].astype(str)+ "_"+ result["grp_id"].astype(str)+ "_"+ result["strand"].astype(str))
        return result

class HitConfidence:

    def calculate_hit_confidence_log(df, e_threshold=1e-5):
        df = df.copy()
        # 1) noise term in log-space (natural log)
        #    noise_weight = 2**(-log2(e_threshold)) noise_logw = -ln(e_threshold)
        noise_logw = -np.log(e_threshold)

        # 2) per-hit log-weight: ln(2**score) = score * ln(2)
        df['log_per_hit_weight'] = df['score'] * np.log(2)
        # 3) group log-sum of per-hit weights
        df['group_log_sum'] = df.groupby('overlap_group')['log_per_hit_weight'].transform(lambda x: np.logaddexp.reduce(x.values))

        # 4) total log-weight = log(group_sum + noise_weight)
        df['total_log_weight'] = np.logaddexp(df['group_log_sum'], noise_logw)

        # 5) hit confidence = per_hit_weight / total_weight in log-space: exp(log_w − total_log_w)
        df['hit_conf'] = np.exp(df['log_per_hit_weight'] - df['total_log_weight'])

        # print any stragglers
        nan_rows = df[df['hit_conf'].isna()][['score','log_per_hit_weight','group_log_sum','total_log_weight','hit_conf']]
        if not nan_rows.empty:
            print("Rows with NaN hit_conf:\n", nan_rows)

        # 7) pick the max-confidence row per overlap_group
        idx = (df.groupby('overlap_group')['hit_conf'].idxmax().dropna().astype(int))
        df_max_conf = df.loc[idx].reset_index(drop=True)
        return df_max_conf

class Prior_Frequencies:

    def read_ko_occurence_txt(KO_OCCURRENCES_TXT, denominator):
        ko_occ = pd.read_csv(KO_OCCURRENCES_TXT, sep=r"\s+", names=['KO id','occurences'])
        idx = ko_occ[ko_occ['KO id'] == "KO_ID"].index
        ko_occ.drop(idx, inplace=True)
        ko_occ['KO_freq'] = ko_occ['occurences'] / denominator
        return ko_occ


class Dk_Calculation:

    def sigma_transform(completeness):
        # 1 - ((exp(3*sigma)-1)/exp(3))
        sigma = 1.0 - ((np.exp(3.0 * completeness) - 1.0) / np.exp(3.0))
        return sigma

    def calculate_dk_per_ko(ko_occurences, bath_hits, completeness):
        df_dk = (bath_hits.merge(ko_occurences, on='KO id', how='left').fillna({'occurences':0,'KO_freq':1e-4}))
        sigma = Dk_Calculation.sigma_transform(completeness)
        df_dk['sigma'] = sigma_val_1
        df_dk['Dk']  = (df_dk['hit_conf']+ (1 - df_dk['hit_conf']) * df_dk['sigma'] * df_dk['KO_freq'])
        return df_dk

class Neighbor_Graph:

    def make_neighbor_dictionary(NEIGHBOR_TXT, df=None):
        with open(NEIGHBOR_TXT) as f:
            neighbor_data = json.load(f)

        adj_raw = {}
        ko_counts = {}
        for ko, nbrs in neighbor_data.items():
            ko_counts[ko] = float(nbrs.get("_count", 0.0))
            out = {}
            for nb, val in nbrs.items():
                if nb == "_count":
                    continue
                out[nb] = float(val)
            if out:
                adj_raw[ko] = out
        return adj_raw, ko_counts

    def p_i_given_j_on_the_fly(i, adj_raw, ko_counts, hit_conf_map_current):
        # Enumerate candidate neighbors j from forward list of i
        forward_nbrs = adj_raw.get(i, {}) or {}
        out = {}
        hit_i = float(hit_conf_map_current.get(i, 0.0))
        for j in forward_nbrs.keys():
            # raw co-occurrence c(i,j) is stored on the reverse edge j -> i
            c_ij = float(adj_raw.get(j, {}).get(i, 0.0))
            denom = float(ko_counts.get(j, 0.0)) + 1.0
            out[j] = (c_ij + hit_i) / denom if denom > 0.0 else 0.0
        return out

    def spring_update_probabilities(dk_dict, adj_raw, ko_counts, hit_conf_map_current, alpha=0.6, return_used=False):
        new_dk = {}
        used_neighbors = {}
        for i, p_i in dk_dict.items():
            #print(i,p_i)
            #nbrs = get_conditional_prob_for_ko_given_neighbor(i, adjacency) or {}
            pij_map = Neighbor_Graph.p_i_given_j_on_the_fly(i, adj_raw, ko_counts, hit_conf_map_current)
            clean = {j: float(w) for j, w in pij_map.items() if isinstance(w, (int, float)) and math.isfinite(float(w)) and float(w) > 0.0}
            used_neighbors[i] = sorted(clean.keys())

            if not clean:
                new_dk[i] = p_i
                continue
            
            S = sum(clean.values())
            if S <= 0.0:
                new_dk[i] = p_i
                continue
            
            X = alpha ** (1.0 / S)
            a_i = 1.0 - p_i
            shift = sum(a_i * (w / S) * X * dk_dict.get(j, 0.0) for j, w in clean.items())
            new_dk[i] = min(p_i + shift, 1.0)

            # optional debug
            if i == "K00845":
                print(f"[{i}] P(i|j): {pij_map}")
                print(f"[{i}] weights used: {clean}")
                print(f"[{i}] S={S}, X={X}, a_i={a_i}, shift={shift}, new={new_dk[i]}")

        #df_spring = (pd.DataFrame.from_dict(new_dk, orient="index", columns=["Dk_Neighbors"]).reset_index().rename(columns={"index": "KO id"}))
        #return (pd.DataFrame.from_dict(new_dk, orient="index", columns=["Dk_Neighbors"]).reset_index().rename(columns={"index": "KO id"}))
        df = (pd.DataFrame.from_dict(new_dk, orient="index", columns=["Dk_Neighbors"]).reset_index().rename(columns={"index": "KO id"}))
        return (df, used_neighbors) if return_used else df
    
    
    def export_pij_for_one(i, adj_raw, ko_counts, hit_conf_map_current, out_csv_path, dk_dict=None):
        """
        Write a CSV with rows for each neighbor j of KO 'i', including:
        KO_i, KO_j, hit_i, c_ij, cnt_j, denom, p_i_given_j, used_by_filter
        If dk_dict is provided, also include Dk_j and w_j_times_p_j columns.
        """
        hit_i = float(hit_conf_map_current.get(i, 0.0))
        # candidates = forward neighbors of i
        candidates = [j for j in (adj_raw.get(i, {}) or {}).keys()
                    if isinstance(j, str) and KO_RE.fullmatch(j)]

        rows = []
        for j in sorted(candidates):
            # reverse-edge raw count: c(i,j) = adj_raw[j].get(i, 0)
            c_ij  = float(adj_raw.get(j, {}).get(i, 0.0))
            cnt_j = float(ko_counts.get(j, 0.0))
            denom = cnt_j + 1.0

            p_ij = (c_ij + hit_i) / denom if denom > 0.0 and math.isfinite(denom) else 0.0
            used = math.isfinite(p_ij) and (p_ij > 0.0)

            row = {"KO_i": i, "KO_j": j, "hit_i": hit_i, "c_ij": c_ij, "cnt_j": cnt_j, "denom": denom, "p_i_given_j": p_ij, "used_by_filter": bool(used)}

            if dk_dict is not None:
                p_j = float(dk_dict.get(j, 0.0))
                row["Dk_j"] = p_j
                row["w_j_times_p_j"] = p_ij * p_j

            rows.append(row)

        df = pd.DataFrame(rows, columns=["KO_i","KO_j","hit_i","c_ij","cnt_j","denom","p_i_given_j","used_by_filter"] + (["Dk_j","w_j_times_p_j"] if dk_dict is not None else []))

        df.to_csv(out_csv_path, index=False)
        print(f"[p(i|j) for {i}] wrote {len(df)} rows to {out_csv_path}")
        return df

class ModuleRepo:

    def module_kos():
        glob.glob(os.path.join(MODULE_JSON_DIR, "module_*_paths.json"))


    def compute_path_probability(path, dk_map):
        p = np.float128(1.0)
        for node in path:
            if '_' in node:
                p *= np.float128(dk_map.get(node.split("_")[0], 1.0))
        return p

    def score_path(path, dk_map, *, alpha=0.6):
        raw = ModuleRepo.compute_path_probability(path, dk_map)
        L   = sum(1 for n in path if 'K' in n)

        if raw > 0 and L>0:
            log_p      = float(np.log(raw))
            avg_log_p  = log_p / L
            geo        = exp(avg_log_p)
        else:
            log_p      = avg_log_p = -np.inf
            geo = 0.0

        return raw, geo


    def find_most_probable_row(paths_dict, dk_map_before, dk_map_after):
        rows = []
        for pid, comma in paths_dict.items():
            path = [n.strip() for n in comma.split(",")]
            r_before, g_before = ModuleRepo.score_path(path, dk_map_before)
            r_after, g_after = ModuleRepo.score_path(path, dk_map_after)
            rows.append({'path_id': int(pid), 'path_str':     " -> ".join(path), 'raw_before': r_before, 'geo_before': g_before, 'raw_after': r_after, 'geo_after': g_after })
        if not rows:
            return None
        # Choose the row with highest geo_after
        best_row = max(rows, key=lambda x: x['geo_after'])
        return best_row

    def path_probabilities(module_json_dir, dk_map_before, dk_map_after):
        best_rows = []
        pattern = os.path.join(module_json_dir, "module_*_paths.json")
        json_files = glob.glob(pattern)

        for json_file in json_files:
            # Extract module name from filename, e.g. 'module_M00001'
            module_name_1 = os.path.basename(json_file).split("_paths.json")[0]
            module_name = os.path.basename(module_name_1).split("module_")[-1]

            # Load the dictionary of paths for this module
            with open(json_file) as f:
                paths_dict = json.load(f)

            # Compute best path for this module
            best = ModuleRepo.find_most_probable_row(paths_dict, dk_map_before, dk_map_after)
            if best:
                best['module'] = module_name
                best_rows.append(best)

        # Turn the list of best‐path dicts into a DataFrame
        df_best = pd.DataFrame(best_rows)

        # Reorder columns for readability
        columns_order = ['module','path_id','path_str','raw_before','geo_before','raw_after','geo_after']
        df_best = df_best[columns_order]
        return df_best

    def modules_to_kos():
        ko_to_modules = {}
        pattern = os.path.join(MODULE_JSON_DIR, "module_*_nodes.json")
        for filepath in glob.glob(pattern):
            # Extract a module name (like “module_M00001”) from filename
            filename = os.path.basename(filepath)
            module_name = filename.replace("_nodes.json", "")
            module_name = module_name.replace("module_", "")

            # Load that module’s node list
            with open(filepath, "r") as f:
                module_nodes = json.load(f)

            # For each node starting with "K", split off the KO part (before the first "_")
            module_kos = {n.split("_", 1)[0] for n in module_nodes if n.startswith("K")}

            # Now register each KO in ko_to_modules
            for ko in module_kos:
                # Create a new list if this is the first time we see `ko`
                if ko not in ko_to_modules:
                    ko_to_modules[ko] = []
                # Append this module’s name (e.g. "module_M00001") to that KO’s list
                ko_to_modules[ko].append(module_name)

        ko_to_modules_str = {ko: ",".join(sorted(mods_list))for ko, mods_list in ko_to_modules.items()}
        return ko_to_modules_str


class Export_Data:
    def export_module_data_with_best_path(
        module_json_dir: str,
        ko_occ_df: pd.DataFrame,
        dk_before: dict,
        evalue: dict,
        dk_after: dict,
        df_best_paths: pd.DataFrame,
        output_path: str
    ):
        
        ko_freq = ko_occ_df.set_index('KO id')['KO_freq'].to_dict()
        # Prepare best_path map, converting all numeric fields to float
        raw_map = df_best_paths.set_index('module')[['path_id','path_str','raw_before','geo_before','raw_after','geo_after']].to_dict(orient='index')

        best_path_map = {}
        for module_id, bp in raw_map.items():
            if bp is None:
                best_path_map[module_id] = None
            else:
                best_path_map[module_id] = {'path_id': int(bp['path_id']),'path_str': bp['path_str'], 'raw_before': float(bp['raw_before']),'geo_before': float(bp['geo_before']),'raw_after': float(bp['raw_after']),'geo_after': float(bp['geo_after'])}

        aggregated = {}
        for node_file in glob.glob(os.path.join(module_json_dir, "module_*_nodes.json")):
            module_id = os.path.basename(node_file).split("_")[1]
            with open(node_file) as f:
                nodes_dict = json.load(f)

            nodes_list = []
            for node, group in nodes_dict.items():
                ko = node.split("_")[0]
                nodes_list.append({
                    "id":             node,
                    "group":          int(group),
                    "KO_Occurrence":  float(ko_freq.get(ko, 0.0)),
                    "Dk_before":      float(dk_before.get(ko, 0.0)),
                    "E-value":        float(evalue.get(ko, 100.0)),
                    "Dk_after":       float(dk_after.get(ko, 0.0)),
                })

            nodes_list.sort(key=lambda x: x["group"])
            aggregated[module_id] = {
                "nodes":     nodes_list,
                "best_path": best_path_map.get(module_id)
            }

        with open(output_path, "w") as f:
            json.dump(aggregated, f, indent=4)

        print(f"Wrote enriched modules and best‐path JSON to {output_path}")

def run_pipeline(
    infile: str,
    sigma: float,
    out_prefix: str,
    module_json_dir: str,
    ko_occ_df: pd.DataFrame,
    one_hop_neighbor_json: str):
    # 1) Parse HMMER
    ext = os.path.basename(infile).split('.')[-1].lower()
    if ext != "domtblout":
        raise NotImplementedError("Only .domtblout is supported in this pipeline.")
    hits = Read_HMMER_Files.read_domtblout(infile)

    # 2) Overlap groups & dedup
    hmm_groups = Group_Overlapping_Annotations.assign_overlap_groups(hits)
    hmm_groups = hmm_groups.drop(columns=["grp_id"])
    hmm_groups = hmm_groups.sort_values('score', ascending=False)
    hmm_groups_dedup = hmm_groups.drop_duplicates(subset='KO id', keep='first')
    print("Number of rows after duplicates dropped:", len(hmm_groups_dedup))

    hmm_hits_1 = HitConfidence.calculate_hit_confidence_log(hmm_groups_dedup.reset_index(), e_threshold=1e-5)
    print("Number of rows after hit confidence calculation:", len(hmm_hits_1))

    ko_to_modules_str = ModuleRepo.modules_to_kos(module_json_dir)
    all_kos_hmm = sorted(ko_to_modules_str.keys())
    print(len(all_kos_hmm))
    df_master_hmm = pd.DataFrame({'KO id': all_kos_hmm})

    hmm_hits_all_kos = df_master_hmm.merge(hmm_hits_1, on='KO id', how='left')
    hmm_hits_all_kos['hit_conf'] = hmm_hits_all_kos['hit_conf'].fillna(0.0)

    detected_kos = set(hmm_hits_1['KO id'])
    module_kos   = set(all_kos_hmm)
    missing_kos = sorted(detected_kos - module_kos)
    print(f"{len(missing_kos)} KOs detected in HMMER output but missing from your module list")
    if missing_kos:
        print(missing_kos)
    print("Number of rows after adding all available KO information:", len(hmm_hits_all_kos))

    # 3) Dk (before neighbors)
    hmm_df_dk = Dk_Calculation.calculate_dk_per_ko(ko_occ_df, hmm_hits_all_kos, sigma)
    hmm_dk_dict = dict(zip(hmm_df_dk['KO id'], hmm_df_dk['Dk']))

    # 4) Neighbor spring update
    adj_raw, ko_counts = Neighbor_Graph.make_neighbor_dictionary(one_hop_neighbor_json)
    hit_conf_map_current = (
        hmm_df_dk[["KO id", "hit_conf"]]
        .fillna({"hit_conf": 0.0})
        .set_index("KO id")["hit_conf"].to_dict()
    )
    hmm_dk_spring_all, used_neighbors = Neighbor_Graph.spring_update_probabilities(
        hmm_dk_dict, adj_raw, ko_counts, hit_conf_map_current, alpha=0.6, return_used=True
    )

    hmm_df_dk_new = hmm_df_dk.merge(hmm_dk_spring_all, on="KO id", how="left")
    hmm_df_dk_new["Modules"] = hmm_df_dk_new["KO id"].map(ko_to_modules_str)
    hmm_df_dk_new = hmm_df_dk_new.dropna(subset=['Modules'])

    series = hmm_df_dk_new.set_index("KO id")["Dk_Neighbors"]
    new_dk_dict = series.to_dict()
    hmm_df_dk_new["KO_Neighbors"] = hmm_df_dk_new["KO id"].map(lambda k: ",".join(used_neighbors.get(k, [])))
    hmm_df_dk_new["KO_Neighbor_Count"] = hmm_df_dk_new["KO id"].map(lambda k: len(used_neighbors.get(k, []))).fillna(0).astype(int)

    # 5) Best paths per module
    hmm_paths = ModuleRepo.path_probabilities(module_json_dir, hmm_dk_dict, new_dk_dict)

    # 6) Outputs
    out_dir = os.path.dirname(out_prefix) or "."
    os.makedirs(out_dir, exist_ok=True)
    hmm_df_dk_new.to_csv(f"{out_prefix}_dk.csv", index=False)
    (hmm_paths if not hmm_paths.empty else pd.DataFrame()).to_csv(f"{out_prefix}_paths.csv", index=False)
    print(f"Reports written to {out_prefix}_dk.csv and {out_prefix}_paths.csv")

    # Graph JSON for UI
    evalue_map = dict(zip(hmm_hits_all_kos['KO id'], hmm_hits_all_kos['E-value'].replace(np.nan, 100.0)))
    Export_Data.export_module_data_with_best_path(
        module_json_dir=module_json_dir,
        ko_occ_df=ko_occ_df,
        dk_before=hmm_dk_dict,
        evalue=evalue_map,
        dk_after=new_dk_dict,
        df_best_paths=hmm_paths,
        output_path=f"{out_prefix}_sample_modules_representation.json"
    )


def build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="BLIMMP Operations")
    p.add_argument('file', help='Path to the .domtblout file')
    p.add_argument('-f', '--format', choices=['domtblout'], required=True,
                   help='Specify which HMMER output format to parse')
    p.add_argument('-s', '--sigma', type=float, required=False, default=1.0,
                   help='Completeness of your sample between [0.0,1.0]. Default 1.0')
    p.add_argument('-o', '--output', required=True,
                   help='Output prefix for CSV/JSON reports')
    return p

def main():
    args = build_arg_parser().parse_args()
    if not (0.0 <= args.sigma <= 1.0):
        raise SystemExit(f"--sigma must be between 0 and 1, but you passed {args.sigma}")

    sample = os.path.basename(args.file).split('.')[0]
    ext = os.path.basename(args.file).split('.')[-1].lower()
    if ext != "domtblout":
        raise SystemExit('--file must be .domtblout format.')

    MODULE_JSON_DIR = "/content/drive/MyDrive/Lab Work/Results_for_PNNL_March_2025/Graph_Generation/New_Updated_KEGG_Graphs_Generated"
    KO_OCC_TXT = "/content/drive/MyDrive/Lab Work/Results_for_PNNL_March_2025/ko_occurences.txt"
    ONE_HOP_NEIGHBOR_STATS = "/content/drive/MyDrive/Lab Work/Results_for_PNNL_March_2025/Tests for module path probabilities/standalone metadata/One_Hop_Neighbor.txt"

    # Load priors once here and pass dataframe into pipeline
    ko_occ_df = Prior_Frequencies.read_ko_occurence_txt(KO_OCC_TXT, denominator=895.0)

    print(f"Processing sample {sample} with sigma={args.sigma}")
    run_pipeline(
        infile=args.file,
        sigma=args.sigma,
        out_prefix=args.output,
        module_json_dir=MODULE_JSON_DIR,
        ko_occ_df=ko_occ_df,
        one_hop_neighbor_json=ONE_HOP_NEIGHBOR_STATS
    )

if __name__ == "__main__":
    main()